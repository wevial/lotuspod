import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' } });
const note = "Sandboxed: this block can't see the page or your comments";
const paused = "Paused. The widget's scripts are stopped. Press Resume to start it again from the beginning.";
const counter = `<style>body { padding: 24px; } output { display: block; font-size: 40px; }</style>
<p>A clock that keeps its place in memory.</p><output>1</output><button>Keep counting</button>
<script>let count = 1; setInterval(() => document.querySelector('output').textContent = String(++count), 300);</script>`;
function publish(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-chrome-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, '# Live experiments\n\n## Pond clock\n\nGive this live block more room, or stop it.\n\n```html live title="Pond clock" id=clock height=260\n' + counter + '\n```\n\n```html live title="Error demonstration" id=errors height=160\n<p>Two deliberate errors.</p><button>Throw twice</button><script>document.querySelector("button").onclick = () => { setTimeout(() => { throw new Error("First intentional error"); }, 0); setTimeout(() => Promise.reject(new Error("<b>value</b>")), 50); };</script>\n```');
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments'], {env: {...env, PYTHONPATH: path.resolve(__dirname, '../../src')}});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('served chrome, lifecycle, expansion and isolated Open alone', async ({page, context}) => {
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
    await expect(page.locator('.artifact-live-note')).toHaveText([note]);
    const errorFigure = page.locator('figure[data-widget="errors"]');
    await page.frameLocator('figure[data-widget="errors"] iframe').getByRole('button').click();
    await expect(errorFigure.locator('.artifact-live-badge')).toHaveText('2 errors');
    await expect(errorFigure.locator('.artifact-live-badge')).toHaveAttribute('title', '<b>value</b>');
    await expect(errorFigure.locator('.artifact-live-badge b')).toHaveCount(0);
    const identity = await frame.evaluateHandle(node => ({node, parent: node.parentNode}));
    const count = async () => Number(await inner.locator('output').textContent());
    await expect.poll(count).toBeGreaterThan(2);
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
    await expect.poll(count).toBeGreaterThan(start);
    await inner.getByRole('button').press('Escape');
    await expect(expand).toBeFocused();
    expect(await inColumn()).toEqual(original);
    const next = await count();
    await expand.click();
    await close.press('Escape');
    await expect(expand).toBeFocused();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(count).toBeGreaterThan(next);
    expect(await inColumn()).toEqual(original);
    expect(await identity.evaluate(({node, parent}) => node === document.querySelector('iframe.artifact-widget') && node.parentNode === parent)).toBe(true);
    await inner.locator('body').evaluate(() => { setTimeout(() => Promise.reject(new Error('Reset this error')), 0); });
    await expect(badge).toHaveText('1 error');
    const heightBeforePause = await frame.evaluate(node => node.getBoundingClientRect().height);
    const widgetURL = new URL((await frame.getAttribute('src'))!, page.url()).href;
    await figure.getByRole('button', {name: 'Pause', exact: true}).click();
    await expect(figure.locator('.artifact-live-paused')).toHaveText(paused);
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
    expect(await popup.evaluate(() => self.origin)).toBe('null');
    await expect.poll(async () => Number(await popup.locator('output').textContent())).toBeGreaterThan(1);
    await popup.close();
    expect(errors.sort()).toEqual(['First intentional error', '<b>value</b>', 'Reset this error'].sort());
  } finally { releaseScript(); releaseWidget(); }
});
