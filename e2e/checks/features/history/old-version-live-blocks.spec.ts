import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// An earlier version of a page with a live block keeps today's widget bridge:
// its block follows the title bar's theme switch, sizes its frame to its
// content and offers Expand and Pause, with no Comment.
const env = process.env;
const NAME = 'old-version-live-blocks';
test.use({
  colorScheme: 'dark',
  extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' },
});

function publish(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), NAME));
  try {
    const file = path.join(dir, `${NAME}.md`);
    fs.writeFileSync(file, '# Pond forecast\n\nA forecast kept with each edition.\n\n' +
      '```html live title="Pond forecast"\n<style>html, body { margin: 0; }\n' +
      '#swatch { color: var(--lotus-color-lavender); height: 520px; }</style>\n' +
      `<div id="swatch"><output>${text}</output></div>\n` + '```\n');
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file,
      '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes',
      '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!],
    { env: { ...env, PYTHONPATH: path.resolve(__dirname, '../../../../src') } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('an old version\'s live block follows the theme, resizes, expands and pauses', async ({ page }) => {
  publish('First forecast: a calm pond.');
  publish('Second forecast: rain over the pond.');
  const response = await page.request.get(`/api/versions?page=${NAME}`);
  expect(response.status()).toBe(200);
  const versions = (await response.json()).versions;
  expect(versions).toHaveLength(2);
  const commit = versions[1].commit;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(`/${NAME}.html?version=${commit}`);
  await expect(page.locator('.artifact-version-banner')).toBeVisible();
  const frame = page.locator('iframe.artifact-widget');
  const inner = page.frameLocator('iframe.artifact-widget');
  await expect(inner.locator('output')).toHaveText('First forecast: a calm pond.');
  await expect(page.locator('.artifact-live-badge')).toHaveText('Live');
  const height = await inner.locator('html').evaluate(node => Math.ceil(node.getBoundingClientRect().height));
  expect(height).not.toBe(360);
  await expect(frame).toHaveAttribute('height', String(height));
  const chrome = page.locator('.artifact-live-chrome');
  await expect(chrome.getByRole('button')).toHaveText(['Expand', 'Pause']);

  const swatch = inner.locator('#swatch');
  const night = await swatch.evaluate(node => getComputedStyle(node).color);
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dawn', exact: true }).click();
  await expect(inner.locator('html')).toHaveAttribute('data-lotus-theme', 'dawn');
  await expect.poll(() => swatch.evaluate(node => getComputedStyle(node).color)).not.toBe(night);
  await page.reload();
  await expect(inner.locator('output')).toHaveText('First forecast: a calm pond.');
  await expect(inner.locator('html')).toHaveAttribute('data-lotus-theme', 'dawn');

  const figure = page.locator('figure', { has: frame });
  const expand = chrome.getByRole('button', { name: 'Expand' });
  await expand.click();
  await expect(figure).toHaveClass(/artifact-live--expanded/);
  await page.keyboard.press('Escape');
  await expect(figure).not.toHaveClass(/artifact-live--expanded/);

  const src = await frame.getAttribute('src');
  expect(src).toMatch(new RegExp(`^${NAME}\\.w-[a-f0-9]{12}\\.html\\?version=${commit}$`));
  await chrome.getByRole('button', { name: 'Pause' }).click();
  await expect(frame).toHaveAttribute('src', 'about:blank');
  await expect(page.locator('.artifact-live-paused')).toBeVisible();
  await chrome.getByRole('button', { name: 'Resume' }).click();
  await expect(frame).toHaveAttribute('src', src!);
  await expect(inner.locator('output')).toHaveText('First forecast: a calm pond.');
  expect(errors).toEqual([]);
});
