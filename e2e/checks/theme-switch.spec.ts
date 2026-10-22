import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The title bar's theme switch (theme-head.js): Night, Dawn and Auto, Auto
// following the system's prefers-color-scheme. The choice is kept in
// localStorage under "lotuspod:theme" and set as data-theme on html before
// the first paint; a live block hears it through the bridge's lotuspod:theme
// message, and a diagram is drawn again in the other set. Every expected
// colour is read from the theme's tokens, never from the stylesheet.
const PAGE = '/capture-palette.html';
const SLUG = 'capture-palette';
const DIAGRAM = '/capture-diagram.html';
// A flowchart whose boxes open cards, and the decisions page, whose title bar
// also holds the review sheet's controls.
const CARDS = '/capture-node-cards.html';
const DECISIONS = '/capture-decisions.html';
const KEY = 'lotuspod:theme';
const ENV = process.env;
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION ?? '' };
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// The pinned Mermaid (e2e/package.json) answers jsDelivr's requests for it,
// as in policy.spec.ts.
const MERMAID_DIR = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
const MERMAID_COPY = path.join(__dirname, '..', 'node_modules', 'mermaid');
const TOKENS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'lotuspod', '_theme', 'tokens.json'), 'utf-8'));
const NIGHT: Record<string, string> = TOKENS.colors;
const DAWN: Record<string, string> = TOKENS.dawn.colors;
const DAWN_STRUCTURE: Record<string, string> = TOKENS.dawn.structure;

test.use({ viewport: WIDE, colorScheme: 'dark', extraHTTPHeaders: SIGNED_IN });

// The page polls /api/comments; a poll still in a route handler when a check
// ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// A token as Chromium reports a computed colour: hex becomes rgb(r, g, b);
// an rgba(r, g, b, a) token is already in that form.
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
    route.fulfill({ json: { page: SLUG, threads: [] } }));
  await page.route(`${MERMAID_DIR}**`, async (route) => {
    const file = path.join(MERMAID_COPY, route.request().url().slice(MERMAID_DIR.length));
    if (!file.startsWith(MERMAID_COPY + path.sep) || !fs.existsSync(file)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(file),
    });
  });
  return errors;
}

function theme(page: Page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

function switchButton(page: Page, name: 'Night' | 'Dawn' | 'Auto') {
  return page.getByRole('group', { name: 'Theme' }).getByRole('button', { name, exact: true });
}

async function pressed(page: Page) {
  const group = page.getByRole('group', { name: 'Theme' });
  return group.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed')]));
}

function stored(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), KEY);
}

function background(page: Page) {
  return page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
}

test('the switch starts on Auto, takes Dawn, keeps it and applies it before the first paint', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${PAGE}?standalone`);
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
  expect(await theme(page)).toBe('night');
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'false'], ['Auto', 'true']]);
  expect(await background(page)).toBe(rgb(NIGHT.night));
  expect(await stored(page)).toBeNull();

  await switchButton(page, 'Dawn').click();
  expect(await theme(page)).toBe('dawn');
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'true'], ['Auto', 'false']]);
  await expect.poll(() => background(page)).toBe(rgb(DAWN.night));
  expect(await page.locator('.artifact-header').evaluate((header) => getComputedStyle(header).boxShadow))
    .toContain(DAWN_STRUCTURE.shadow);
  expect(await stored(page)).toBe('dawn');

  // What the root says at the first frame the page paints.
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      (window as any).firstFrameTheme = document.documentElement.getAttribute('data-theme');
    });
  });
  await page.reload();
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).firstFrameTheme)).toBe('dawn');
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'true'], ['Auto', 'false']]);
  expect(errors).toEqual([]);
});

test('Auto forgets the choice and follows the system as it changes', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${PAGE}?standalone`);
  await switchButton(page, 'Dawn').click();
  expect(await stored(page)).toBe('dawn');
  await switchButton(page, 'Auto').click();
  expect(await stored(page)).toBeNull();
  expect(await theme(page)).toBe('night');
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'false'], ['Auto', 'true']]);

  // Marked, so a reload would show as the mark gone.
  await page.evaluate(() => { (window as any).sameDocument = true; });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('dawn');
  expect(await background(page)).toBe(rgb(DAWN.night));
  expect(await page.evaluate(() => (window as any).sameDocument)).toBe(true);
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'false'], ['Auto', 'true']]);

  // Night holds on a light system.
  await switchButton(page, 'Night').click();
  expect(await theme(page)).toBe('night');
  expect(await background(page)).toBe(rgb(NIGHT.night));
  expect(errors).toEqual([]);
});

test('storage that throws reads as Auto, and a press still applies', async ({ page }) => {
  const errors = await watch(page);
  await page.addInitScript(() => {
    const refuse = () => { throw new DOMException('Storage is refused', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: refuse });
  });
  await page.goto(`${PAGE}?standalone`);
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
  expect(await theme(page)).toBe('night');
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'false'], ['Auto', 'true']]);
  await switchButton(page, 'Dawn').click();
  expect(await theme(page)).toBe('dawn');
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'true'], ['Auto', 'false']]);
  await expect.poll(() => background(page)).toBe(rgb(DAWN.night));
  expect(errors).toEqual([]);
});

// A page of the check's own, published as hermes with a real `lotuspod
// publish --local`: its live block names, through lotuspod.state(), the
// frame's lotuspod.theme and its own --lotus-color-night, on each
// lotuspod:theme and every 200 ms, so a label the frame's load clears is
// named again.
const LIVE = 'theme-switch-live';
const BLOCK = [
  '<p>The block reads the theme.</p>',
  '<script>',
  'function name() {',
  '  var night = getComputedStyle(document.documentElement).getPropertyValue("--lotus-color-night").trim();',
  '  window.lotuspod.state(window.lotuspod.theme + " " + night);',
  '}',
  'document.addEventListener("lotuspod:theme", name);',
  'setInterval(name, 200);',
  'name();',
  '</script>',
].join('\n');

function publishLive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-switch-'));
  try {
    const file = path.join(dir, `${LIVE}.md`);
    fs.writeFileSync(file, ['# Theme in a block', '', '## The block', '', 'A block that names its theme.', '',
      '```html live title="Theme reader"', BLOCK, '```', ''].join('\n'));
    execFileSync(ENV.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir',
      ENV.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES!],
    { env: { ...ENV, PYTHONPATH: path.resolve(__dirname, '..', '..', 'src') } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.beforeAll(publishLive);

test('a live block follows a press, a kept choice and a light system', async ({ page, browser }) => {
  const errors = await watch(page);
  await page.goto(`/${LIVE}.html?standalone`);
  const label = page.locator('figure.artifact-live .artifact-live-state');
  await expect(label).toHaveText(`night ${NIGHT.night}`);
  await switchButton(page, 'Dawn').click();
  await expect(label).toHaveText(`dawn ${DAWN.night}`);

  // Dawn kept, the system dark: the frame is told as it opens.
  await page.reload();
  await expect(label).toHaveText(`dawn ${DAWN.night}`);
  expect(await pressed(page)).toEqual([['Night', 'false'], ['Dawn', 'true'], ['Auto', 'false']]);
  await switchButton(page, 'Night').click();
  await expect(label).toHaveText(`night ${NIGHT.night}`);
  expect(errors).toEqual([]);

  // Auto, nothing kept, on a light system.
  const light = await browser.newContext({ viewport: WIDE, colorScheme: 'light', extraHTTPHeaders: SIGNED_IN });
  try {
    const other = await light.newPage();
    const otherErrors = await watch(other);
    await other.goto(`/${LIVE}.html?standalone`);
    expect(await theme(other)).toBe('dawn');
    expect(await pressed(other)).toEqual([['Night', 'false'], ['Dawn', 'false'], ['Auto', 'true']]);
    await expect(other.locator('figure.artifact-live .artifact-live-state')).toHaveText(`dawn ${DAWN.night}`);
    await other.unrouteAll({ behavior: 'ignoreErrors' });
    expect(otherErrors).toEqual([]);
  } finally {
    await light.close();
  }
});

test('in Dawn a live block is a white card with a mint sandbox band, and an agent replies on the paper', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`/${LIVE}.html?standalone`);
  const figure = page.locator('figure.artifact-live');
  const note = figure.locator('.artifact-live-note');
  const fill = (target: typeof figure) => target.evaluate((node) => getComputedStyle(node).backgroundColor);
  await switchButton(page, 'Night').click();
  expect(await fill(figure)).toBe(rgb(NIGHT.night));
  expect(await fill(note)).toBe('rgba(0, 0, 0, 0)');
  await switchButton(page, 'Dawn').click();
  expect(await fill(figure)).toBe(rgb(DAWN.surface));
  expect(await fill(note)).toBe(DAWN_STRUCTURE.mint_tint);
  const badge = figure.locator('.artifact-live-badge');
  await expect(badge).toHaveText('Live');
  expect(await fill(badge)).toBe('rgba(0, 0, 0, 0)');
  expect(await badge.evaluate((node) => getComputedStyle(node).boxShadow)).toBe(`${rgb(DAWN.mint)} 0px 0px 0px 1px inset`);

  // A thread on the palette page: the reader's question and hermes's reply.
  const at = { page: SLUG, section: 'links-and-code', sectionTitle: 'Links and code', revision: '', quote: null,
    createdAt: '2026-10-06T17:54:00.000Z', state: 'answered' };
  const root = { ...at, id: 9001, parent: null, text: 'Is the link right?', actor: { kind: 'human', name: 'maintainer' } };
  const reply = { ...at, id: 9002, parent: 9001, text: 'It is.', actor: { kind: 'agent', handle: 'hermes' } };
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: SLUG, threads: [{ root, replies: [reply] }] } }));
  await page.goto(`${PAGE}?standalone`);
  await page.locator('details.artifact-comment[data-section="links-and-code"] summary').click();
  const agent = page.locator('.artifact-comment-thread[data-thread="9001"] .artifact-comment-item--agent .artifact-comment-text');
  await expect(agent).toBeVisible();
  expect(await agent.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(rgb(DAWN.night));
  // The open thread around it is a white card.
  const entry = page.locator('.artifact-comments-entry--open').filter({ has: agent });
  expect(await entry.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(rgb(DAWN.surface));
  await switchButton(page, 'Night').click();
  expect(await entry.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(rgb(NIGHT.night));
  expect(await agent.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(rgb(NIGHT.surface));
  expect(errors).toEqual([]);
});

function shapeFill(page: Page, selector = 'pre.mermaid > svg g.node rect') {
  return page.evaluate((selector) => {
    const shape = document.querySelector(selector);
    return shape ? getComputedStyle(shape).fill : null;
  }, selector);
}

test('a diagram is drawn again in the other set on each press', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${DIAGRAM}?standalone`);
  await expect.poll(() => shapeFill(page)).toBe(rgb(NIGHT.surface));
  await switchButton(page, 'Dawn').click();
  await expect.poll(() => shapeFill(page)).toBe(rgb(DAWN.surface));
  expect(await page.locator('pre.mermaid > svg').count()).toBe(1);
  await switchButton(page, 'Night').click();
  await expect.poll(() => shapeFill(page)).toBe(rgb(NIGHT.surface));
  expect(await page.locator('pre.mermaid > svg').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('a quick Dawn then Night settles in Night', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${DIAGRAM}?standalone`);
  await expect.poll(() => shapeFill(page)).toBe(rgb(NIGHT.surface));
  await switchButton(page, 'Dawn').click();
  await switchButton(page, 'Night').click();
  await switchButton(page, 'Dawn').click();
  await switchButton(page, 'Night').click();
  await page.waitForTimeout(1500);
  expect(await theme(page)).toBe('night');
  expect(await shapeFill(page)).toBe(rgb(NIGHT.surface));
  expect(await page.locator('pre.mermaid > svg').count()).toBe(1);
  expect(errors).toEqual([]);
});

test("a diagram's boxes still open their cards once it is drawn again", async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${CARDS}?standalone`);
  const boxes = page.locator('pre.mermaid').first().locator('g.artifact-node[role="button"]');
  await expect(boxes.first()).toBeVisible();
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);
  await switchButton(page, 'Dawn').click();
  await expect.poll(() => shapeFill(page, 'pre.mermaid > svg g.node .label-container')).not.toBe(rgb(NIGHT.surface));
  await expect(boxes).toHaveCount(count);
  await boxes.first().click();
  await expect(page.locator('.artifact-node-card')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a diagram open in its view is drawn in the new theme there, and keeps it once closed', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${DIAGRAM}?standalone`);
  await expect.poll(() => shapeFill(page)).toBe(rgb(NIGHT.surface));
  await page.locator('pre.mermaid').getByRole('button', { name: 'Expand diagram' }).click();
  await expect(page.locator('dialog.artifact-diagram-view')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('dawn');
  // Drawn again where it is shown, in the dialog.
  await expect.poll(() => shapeFill(page, 'dialog.artifact-diagram-view svg g.node rect')).toBe(rgb(DAWN.surface));
  expect(await page.locator('dialog.artifact-diagram-view svg').count()).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.artifact-diagram-view')).toBeHidden();
  await expect.poll(() => shapeFill(page)).toBe(rgb(DAWN.surface));
  expect(await page.locator('pre.mermaid > svg').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('a diagram expanded while it is being drawn again is drawn in the new theme once closed', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`${DIAGRAM}?standalone`);
  await expect.poll(() => shapeFill(page)).toBe(rgb(NIGHT.surface));
  // Expanded as the new drawing starts, out of sight at the end of the
  // body, before Mermaid can finish it.
  await page.evaluate(() => {
    const started = new MutationObserver(() => {
      if (!document.querySelector('body > pre.mermaid')) return;
      started.disconnect();
      (document.querySelector('.artifact-body pre.mermaid .artifact-diagram-expand') as HTMLElement).click();
    });
    started.observe(document.body, { childList: true });
    (document.querySelector('.artifact-theme-option[data-theme-choice="dawn"]') as HTMLElement).click();
  });
  await expect(page.locator('dialog.artifact-diagram-view')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.artifact-diagram-view')).toBeHidden();
  await expect.poll(() => shapeFill(page)).toBe(rgb(DAWN.surface));
  expect(await page.locator('pre.mermaid > svg').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('a widget opened alone follows the system as it changes', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`/${LIVE}.html?standalone`);
  const file = await page.locator('iframe.artifact-widget').getAttribute('src');
  await page.addInitScript(() => {
    document.addEventListener('lotuspod:theme', (event) => {
      (window as any).heard = (event as CustomEvent).detail.theme;
    });
  });
  await page.goto(`/${file}`);
  expect(await page.evaluate(() => (window as any).lotuspod.theme)).toBe('night');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => (window as any).lotuspod.theme)).toBe('dawn');
  expect(await page.evaluate(() => (window as any).heard)).toBe('dawn');
  expect(errors).toEqual([]);
});

test('beside the review sheet on a phone the switch is one button in the window that steps through the choices', async ({ page }) => {
  const errors = await watch(page);
  for (const width of [375, 320, 280]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`${DECISIONS}?standalone`);
    await expect(page.locator('.artifact-review-bar')).toBeVisible();
    const group = page.getByRole('group', { name: 'Theme' });
    await expect(group.getByRole('button')).toHaveCount(1);
    const button = group.getByRole('button', { name: 'Theme: Auto' });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x, `at ${width}`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `at ${width}`).toBeLessThanOrEqual(width);
    const bar = (await page.locator('.artifact-topbar').boundingBox())!;
    expect(box.y + box.height, `at ${width}`).toBeLessThanOrEqual(bar.y + bar.height);
    const count = (await page.locator('.artifact-review-count').boundingBox())!;
    expect(count.x + count.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await button.click();
    await expect(group.getByRole('button', { name: 'Theme: Night' })).toHaveAttribute('title', 'Theme: Night');
    await group.getByRole('button').click();
    await expect(group.getByRole('button', { name: 'Theme: Dawn' })).toHaveText('D');
    expect(await theme(page)).toBe('dawn');
    expect(await stored(page)).toBe('dawn');
    await group.getByRole('button').click();
    await expect(group.getByRole('button', { name: 'Theme: Auto' })).toBeVisible();
    expect(await stored(page)).toBeNull();
  }
  expect(errors).toEqual([]);
});

test('on a phone the switch shows whole in the title bar and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const errors = await watch(page);
  await page.goto(`${PAGE}?standalone`);
  for (const name of ['Night', 'Dawn', 'Auto'] as const) {
    const button = switchButton(page, name);
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  expect(errors).toEqual([]);
});
