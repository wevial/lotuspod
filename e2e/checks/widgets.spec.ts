import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const env = process.env;
const signedIn = { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' };
test.use({ extraHTTPHeaders: signedIn });

function publish(name: string, content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widgets-'));
  try {
    const file = path.join(dir, name + '.md');
    fs.writeFileSync(file, '# Pond experiments\n\n## Watch the pond\n\nA small experiment in the reading column.\n\n```html live title="Pond clock"\n' + content + '\n```\n\n## What changed\n\nThe page stays separate from its widget.\n');
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments'], {env: {...env, PYTHONPATH: path.resolve(__dirname, '../../src')}});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

const clock = `<style>
body { padding: 24px; box-sizing: border-box; }
#swatch { color: var(--lotus-color-lavender); }
button { font: inherit; padding: 12px; }
#output { margin-top: 20px; }
</style>
<div id="swatch">Pond clock</div><button>Press me</button><div id="output"></div>
<script>
document.querySelector('button').addEventListener('click', () => {
  document.querySelector('#output').textContent = 'A ripple moves across the pond.';
  document.querySelector('#output').style.height = '220px';
});
</script>`;

test('widget script, theme, resize and strictly validated messages', async ({page}) => {
  publish('widget-bridge', clock);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    (window as any).widgetEvents = [];
    new MutationObserver(() => {
      document.querySelectorAll('iframe.artifact-widget').forEach(frame => {
        if ((frame as any).watching) return;
        (frame as any).watching = true;
        frame.addEventListener('lotuspod:widget', event => (window as any).widgetEvents.push((event as CustomEvent).detail));
      });
    }).observe(document, {childList: true, subtree: true});
  });
  await page.goto('/widget-bridge.html?standalone');
  const frame = page.locator('iframe.artifact-widget');
  const inner = page.frameLocator('iframe.artifact-widget');
  await expect.poll(() => page.evaluate(() => (window as any).widgetEvents.filter((e: any) => e.kind === 'ready').length)).toBe(1);
  await expect(inner.locator('#swatch')).toHaveCSS('color', 'rgb(183, 156, 244)');
  const before = Number(await frame.getAttribute('height'));
  await inner.getByRole('button').click();
  await expect(inner.locator('#output')).toHaveText('A ripple moves across the pond.');
  await expect.poll(async () => Number(await frame.getAttribute('height'))).toBeGreaterThan(before);
  await inner.locator('body').evaluate(() => parent.postMessage({type: 'lotuspod:resize', height: 700}, '*'));
  await expect(frame).toHaveAttribute('height', '700');
  await page.evaluate(() => window.postMessage({type: 'lotuspod:resize', height: 900}, '*'));
  await inner.locator('body').evaluate(() => {
    for (const data of [
      {type: 'other', height: 900}, {type: 'lotuspod:resize', height: 900, extra: true},
      ...[-5, 10001, 12.5].map(height => ({type: 'lotuspod:resize', height})),
      {type: 'lotuspod:error', message: 'x'.repeat(201)}, {type: 'lotuspod:ready', extra: true},
    ]) parent.postMessage(data, '*');
  });
  await page.waitForTimeout(150);
  await expect(frame).toHaveAttribute('height', '700');
  await inner.locator('body').evaluate(() => { setTimeout(() => { throw new Error('Pond error'); }, 0); });
  await expect.poll(() => page.evaluate(() => (window as any).widgetEvents.filter((e: any) => e.kind === 'error').length)).toBe(1);
  await inner.getByRole('button').press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).widgetEvents.filter((e: any) => e.kind === 'escape').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).widgetEvents.find((e: any) => e.kind === 'error').message)).toContain('Pond error');
  await inner.locator('body').evaluate(() => {
    for (let i = 0; i < 100; i++) parent.postMessage({type: 'lotuspod:error', message: 'burst'}, '*');
  });
  await page.waitForTimeout(150);
  const count = await page.evaluate(() => (window as any).widgetEvents.filter((e: any) => e.message === 'burst').length);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(60);
  expect(errors).toEqual(['Pond error']);
});

test('startup messages arrive while the deferred page script is held back', async ({page}) => {
  publish('widget-startup', '<style>html { height: 900px; }</style><p>Ready before the page bundle.</p>');
  await page.addInitScript(() => {
    (window as any).widgetEvents = [];
    new MutationObserver(() => {
      document.querySelectorAll('iframe.artifact-widget').forEach(frame => {
        if ((frame as any).watching) return;
        (frame as any).watching = true;
        frame.addEventListener('lotuspod:widget', event => (window as any).widgetEvents.push((event as CustomEvent).detail));
      });
    }).observe(document, {childList: true, subtree: true});
  });
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/lotuspod-page.js?*', async route => {
    requested();
    await delivery;
    await route.continue();
  });
  try {
    await page.goto('/widget-startup.html?standalone', {waitUntil: 'commit'});
    await request;
    const frame = page.locator('iframe.artifact-widget');
    await frame.scrollIntoViewIfNeeded();
    await expect(frame).toHaveAttribute('height', '900');
    await expect.poll(() => page.evaluate(() => (window as any).widgetEvents)).toEqual([{kind: 'ready', message: ''}]);
  } finally {
    release();
  }
  await page.waitForLoadState('load');
  // Loading the page bundle must not install a second receiver.
  await page.frameLocator('iframe.artifact-widget').locator('body').evaluate(() => {
    parent.postMessage({type: 'lotuspod:error', message: 'after delivery'}, '*');
  });
  await expect.poll(() => page.evaluate(() => (window as any).widgetEvents)).toEqual([
    {kind: 'ready', message: ''}, {kind: 'error', message: 'after delivery'},
  ]);
});

test('opaque origin blocks page, storage, network, popups and top navigation; comments still post', async ({page, context}) => {
  publish('widget-isolation', `<div id="results"></div><script>
const results = document.querySelector('#results');
function note(s) { results.append(document.createTextNode(s + '\\n')); }
function attempt(name, fn) { try { if (fn() === null) note(name + ' blocked'); else note(name + ' FAILED'); } catch { note(name + ' blocked'); } }
attempt('parent', () => parent.document);
attempt('cookie', () => document.cookie);
attempt('storage', () => localStorage);
attempt('popup', () => window.open('/'));
if (self !== top) attempt('top', () => { top.location = '/'; });
document.addEventListener('securitypolicyviolation', e => note(e.effectiveDirective + ' violation'));
fetch('/api/whoami').then(() => note('fetch FAILED'), () => note('fetch blocked'));
</script>`);
  await page.goto('/widget-isolation.html?standalone');
  const inner = page.frameLocator('iframe.artifact-widget');
  for (const name of ['parent', 'cookie', 'storage', 'popup', 'top', 'fetch']) {
    await expect(inner.locator('#results')).toContainText(name + ' blocked');
  }
  await expect(inner.locator('#results')).toContainText('connect-src violation');
  const src = await page.locator('iframe.artifact-widget').getAttribute('src');
  const alone = await context.newPage();
  await alone.goto('/' + src);
  expect(await alone.evaluate(() => self.origin)).toBe('null');
  await alone.close();
  await page.locator('details.artifact-comment[data-section="watch-the-pond"] summary').click();
  // The page's authenticated comment flow remains available beside the widget.
  await page.getByRole('textbox', {name: 'Comment on Watch the pond', exact: true}).fill('The pond widget is isolated.');
  await page.getByRole('button', {name: 'Comment', exact: true}).click();
  await expect(page.locator('.artifact-comment-text').filter({hasText: 'The pond widget is isolated.'})).toBeVisible();
});
