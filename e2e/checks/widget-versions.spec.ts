import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' } });

test('an earlier page runs its own historical widget with read-only chrome', async ({ page }) => {
  const name = 'widget-versions-check';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const publish = (text: string, widget = true) => {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, '# Pond forecast\n\nA forecast preserved with each edition.\n\n' +
      (widget ? '```html live title="Pond forecast" height=240\n<output></output>' +
      `<script>document.querySelector('output').textContent = '${text}';</script>\n` +
      '```\n' : text));
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file,
      '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes',
      '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!],
    { env: { ...env, PYTHONPATH: path.resolve(__dirname, '../../src') } });
  };
  try {
    publish('First forecast: a calm pond.');
    publish('Second forecast: rain over the pond.');
    publish('The forecast was removed.', false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const response = await page.request.get(`/api/versions?page=${name}`);
  expect(response.status()).toBe(200);
  const versions = (await response.json()).versions;
  expect(versions).toHaveLength(3);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`/${name}.html?version=${versions[2].commit}`);
  await expect(page.locator('.artifact-version-banner')).toContainText('2 versions behind');
  await expect(page.frameLocator('iframe.artifact-widget').locator('output'))
    .toHaveText('First forecast: a calm pond.');
  // Today's bridge replaces the served badge once the block has loaded, and
  // draws no Comment: an earlier version loads no page script.
  await expect(page.locator('.artifact-live-badge')).toHaveText('Live');
  await expect(page.locator('.artifact-live-chrome button')).toHaveText(['Expand', 'Pause']);
  const frame = page.locator('iframe.artifact-widget');
  const src = await frame.getAttribute('src');
  expect(src).toMatch(new RegExp(`^${name}\\.w-[a-f0-9]{12}\\.html\\?version=${versions[2].commit}$`));
  await expect(page.getByRole('link', { name: 'Open alone' })).toHaveAttribute('href', src!);
  expect(await frame.evaluate(node => node.getBoundingClientRect().height)).toBe(240);
  await expect(page.getByRole('button', { name: 'Choose a version' })).toBeVisible();
  // Of the page's own scripts only today's widget bridge and theme head are
  // left; then the old-version script. Both hold "lotuspod:theme", so the
  // bridge is told apart by its installer.
  expect(await page.locator('script').evaluateAll(nodes => nodes.map(node => {
    const script = node as HTMLScriptElement;
    if (script.src) return new URL(script.src).pathname;
    if (script.text.includes('installWidgetBridge')) return 'widget bridge';
    return script.text.includes('"lotuspod:theme"') ? 'theme head' : 'another inline script';
  }))).toEqual(['widget bridge', 'theme head', '/lotuspod-old-version.js']);
  expect(errors).toEqual([]);
});
