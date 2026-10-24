import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' } });
const counter = `<style>body { padding: 24px; } output { display: block; font-size: 40px; }</style>
<p>A clock that keeps its place in memory.</p><output>1</output><button>Keep counting</button>
<script>let count = 1; setInterval(() => document.querySelector('output').textContent = String(++count), 300);</script>`;
function publish(name: string, sizing = "height=260", style = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-chrome-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, '# Live experiments\n\n## Pond clock\n\nGive this live block more room, or stop it.\n\n```html live title="Pond clock" id=clock ' + sizing + '\n' + `<style>${style}</style>` + counter + '\n```\n\n```html live title="Error demonstration" id=errors height=160\n<p>Two deliberate errors.</p><button>Throw twice</button><script>document.querySelector("button").onclick = () => { setTimeout(() => { throw new Error("First intentional error"); }, 0); setTimeout(() => Promise.reject(new Error("<b>value</b>")), 50); };</script>\n```');
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments'], {env: {...env, PYTHONPATH: path.resolve(__dirname, '../../../../src')}});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('served chrome, lifecycle, expansion and isolated Open alone: height=260', async ({page, context}) => {
  publish('widget-chrome');
  const errors: string[] = [];
  context.on('page', other => {
    other.on('pageerror', error => errors.push(error.message));
    other.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let releaseScript!: () => void;
  let releaseWidget!: () => void;
  const scriptGate = new Promise<void>(resolve => { releaseScript = resolve; });
  let widgetGate = new Promise<void>(resolve => { releaseWidget = resolve; });
  await page.route(url => url.pathname === '/lotuspod-page.js', async route => { await scriptGate; await route.continue(); });
  await page.route(/\.w-[a-f0-9]+\.html$/, async route => { await widgetGate; await route.continue(); });
  const figure = page.locator('figure[data-widget="clock"]');
  const frame = figure.locator('iframe');
  const inner = page.frameLocator('figure[data-widget="clock"] iframe');
  const badge = figure.locator('.artifact-live-badge');
  const expand = figure.getByRole('button', {name: 'Expand', exact: true});
  const position = () => page.evaluate(() => ['.artifact-main', 'iframe.artifact-widget'].map(selector => document.querySelector(selector)!.getBoundingClientRect().top + scrollY));
  try {
    await page.goto('/widget-chrome.html?standalone', {waitUntil: 'commit'});
    await expect(frame).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const before = await position();
    await expect(badge).toHaveText('loading');
    await expect(figure.locator('button')).toHaveCount(0);
    releaseScript();
    await expect(expand).toBeVisible();
    await expect(figure.getByRole('button', {name: 'Pause', exact: true})).toBeVisible();
    const after = await position();
    before.forEach((top, index) => expect(Math.abs(top - after[index])).toBeLessThanOrEqual(0.5));
    await expect(badge).toHaveText('loading');
    await expect(badge).not.toHaveAttribute('title');
    releaseWidget();
    await expect(badge).toHaveText('Live');
    await expect(page.locator('.artifact-live-note')).toHaveText(["Sandboxed: this block can't see the page or your comments"]);
    const errorFigure = page.locator('figure[data-widget="errors"]');
    await page.frameLocator('figure[data-widget="errors"] iframe').getByRole('button').click();
    await expect(errorFigure.locator('.artifact-live-badge')).toHaveText('2 errors');
    await expect(errorFigure.locator('.artifact-live-badge')).toHaveAttribute('title', '<b>value</b>');
    await expect(errorFigure.locator('.artifact-live-badge b')).toHaveCount(0);
    const identity = await frame.evaluateHandle(node => ({node, parent: node.parentNode}));
    const count = async () => Number(await inner.locator('output').textContent());
    await expect.poll(count).toBeGreaterThan(2);
    // A unique token belongs to this document, not its persistent WindowProxy.
    // Counter polling alone can pass after a reload catches up to the old count.
    const documentToken = await inner.locator('body').evaluate(() => {
      const token = crypto.randomUUID();
      document.documentElement.dataset.continuity = token;
      return token;
    });
    const continuous = async (previous: number) => {
      expect(await inner.locator('html').getAttribute('data-continuity')).toBe(documentToken);
      expect(await count()).toBeGreaterThanOrEqual(previous);
      await expect.poll(count).toBeGreaterThan(previous);
      expect(await inner.locator('html').getAttribute('data-continuity')).toBe(documentToken);
    };
    const start = await count();
    const inColumn = () => figure.evaluate(node => {
      const box = node.getBoundingClientRect();
      return {x: box.x, y: box.y + scrollY, width: box.width, height: box.height};
    });
    const original = await inColumn();
    await expand.click();
    const close = figure.getByRole('button', {name: 'Close', exact: true});
    await expect(close).toHaveAttribute('aria-expanded', 'true');
    const box = (await figure.boundingBox())!;
    const bar = (await page.locator('.artifact-topbar').boundingBox())!;
    const viewport = page.viewportSize()!;
    for (const difference of [box.x, box.y - bar.y - bar.height, box.width - viewport.width, box.y + box.height - viewport.height]) expect(Math.abs(difference)).toBeLessThanOrEqual(1);
    expect(await identity.evaluate(({node, parent}) => node === document.querySelector('iframe.artifact-widget') && node.parentNode === parent)).toBe(true);
    await continuous(start);
    const beforeFrameEscape = await count();
    await inner.getByRole('button').press('Escape');
    await expect(expand).toBeFocused();
    expect(await inColumn()).toEqual(original);
    await continuous(beforeFrameEscape);
    const next = await count();
    await expand.click();
    await continuous(next);
    const beforePageEscape = await count();
    await close.press('Escape');
    await expect(expand).toBeFocused();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await continuous(beforePageEscape);
    expect(await inColumn()).toEqual(original);
    expect(await identity.evaluate(({node, parent}) => node === document.querySelector('iframe.artifact-widget') && node.parentNode === parent)).toBe(true);
    const beforeButtonClose = await count();
    await expand.click();
    await continuous(beforeButtonClose);
    const expandedCount = await count();
    await close.click();
    await expect(expand).toBeFocused();
    expect(await inColumn()).toEqual(original);
    await continuous(expandedCount);
    await inner.locator('body').evaluate(() => { setTimeout(() => Promise.reject(new Error('Reset this error')), 0); });
    await expect(badge).toHaveText('1 error');
    const heightBeforePause = await frame.evaluate(node => node.getBoundingClientRect().height);
    const widgetURL = new URL((await frame.getAttribute('src'))!, page.url()).href;
    await figure.getByRole('button', {name: 'Pause', exact: true}).click();
    await expect(figure.locator('.artifact-live-paused')).toHaveText("Paused. The widget's scripts are stopped. Press Resume to start it again from the beginning.");
    await expect(figure.locator('.artifact-live-paused')).toBeVisible();
    expect(await frame.evaluate(node => node.getBoundingClientRect().height)).toBe(heightBeforePause);
    await expect.poll(() => page.frames().some(item => item.url() === widgetURL)).toBe(false);
    widgetGate = new Promise<void>(resolve => { releaseWidget = resolve; });
    await figure.getByRole('button', {name: 'Resume', exact: true}).click();
    await expect(badge).toHaveText('loading');
    await expect(badge).not.toHaveAttribute('title');
    releaseWidget();
    await expect(inner.locator('output')).toHaveText('1');
    await expect(badge).toHaveText('Live');
    const popupPromise = context.waitForEvent('page');
    await figure.getByRole('link', {name: 'Open alone'}).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(widgetURL);
    const alone = popup.frameLocator('iframe');
    await expect(alone.locator('output')).toBeVisible();
    expect(await alone.locator('body').evaluate(() => self.origin)).toBe('null');
    await expect.poll(async () => Number(await alone.locator('output').textContent())).toBeGreaterThan(1);
    await popup.close();
    expect(errors.sort()).toEqual(['First intentional error', '<b>value</b>', 'Reset this error'].sort());
  } finally { releaseScript(); releaseWidget(); }
});

test('a block sized by its own page fills the window under the top bar when expanded, and Close puts it back in the column', async ({page}) => {
  for (const style of ['body { min-height: 100vh; box-sizing: border-box; margin: 0; }', 'html, body { height: 100%; box-sizing: border-box; margin: 0; }']) {
    publish('widget-chrome-fill', '', style);
    await page.goto('/widget-chrome-fill.html?standalone');
    const figure = page.locator('figure[data-widget="clock"]');
    const frame = figure.locator('iframe');
    const expand = figure.getByRole('button', {name: 'Expand', exact: true});
    await expect(figure.locator('.artifact-live-badge')).toHaveText('Live');
    await page.evaluate(() => document.fonts.ready);
    const identity = await frame.evaluateHandle(node => ({node, parent: node.parentNode}));
    const inColumn = () => figure.evaluate(node => {
      const box = node.getBoundingClientRect();
      return {x: box.x, y: box.y + scrollY, width: box.width, height: box.height};
    });
    const original = await inColumn();
    await expand.click();
    const close = figure.getByRole('button', {name: 'Close', exact: true});
    await expect(close).toHaveAttribute('aria-expanded', 'true');
    const box = (await figure.boundingBox())!;
    const bar = (await page.locator('.artifact-topbar').boundingBox())!;
    const viewport = page.viewportSize()!;
    for (const difference of [box.x, box.y - bar.y - bar.height, box.width - viewport.width, box.y + box.height - viewport.height]) expect(Math.abs(difference), style).toBeLessThanOrEqual(1);
    expect(await identity.evaluate(({node, parent}) => node === document.querySelector('iframe.artifact-widget') && node.parentNode === parent)).toBe(true);
    await close.click();
    await expect(expand).toBeFocused();
    expect(await inColumn(), style).toEqual(original);
  }
});

test('narrow chrome reserves space and keeps title and controls visible', async ({page}) => {
  publish('widget-chrome-narrow');
  await page.setViewportSize({width: 320, height: 900});
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/lotuspod-page.js', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/widget-chrome-narrow.html?standalone', {waitUntil: 'commit'});
    const figure = page.locator('figure[data-widget="clock"]');
    const frame = figure.locator('iframe');
    await expect(frame).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const top = (await frame.boundingBox())!.y;
    release();
    await expect(figure.getByRole('button', {name: 'Pause', exact: true})).toBeVisible();
    expect(Math.abs((await frame.boundingBox())!.y - top)).toBeLessThanOrEqual(0.5);
    await expect(figure.locator('.artifact-live-badge')).toHaveText('Live');
    // Exercise large counts through the bridge without generating console errors.
    await page.frameLocator('figure[data-widget="clock"] iframe').locator('body').evaluate(() => {
      for (let i = 0; i < 2; i++) parent.postMessage({type: 'lotuspod:error', message: 'Layout check'}, '*');
    });
    await expect(figure.locator('.artifact-live-badge')).toHaveText('2 errors');
    const fits = async () => {
      const bounds = (await figure.boundingBox())!;
      const elements = figure.locator('.artifact-live-title, .artifact-live-badge, .artifact-live-chrome button, .artifact-live-chrome a');
      for (const element of await elements.all()) {
        const box = (await element.boundingBox())!;
        expect(box.width).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    };
    await fits();
    // Text sizing is independent of error delivery's rate limit.
    await figure.locator('.artifact-live-badge').evaluate(node => { node.textContent = '100 errors'; });
    await figure.getByRole('button', {name: 'Pause', exact: true}).click();
    await expect(figure.getByRole('button', {name: 'Resume', exact: true})).toBeVisible();
    await fits();
    expect(errors).toEqual([]);
  } finally { release(); }
});
