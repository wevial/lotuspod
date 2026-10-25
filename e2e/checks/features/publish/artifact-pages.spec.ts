import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// `lotuspod publish --artifact`: a Claude artifact's HTML file as a live pod,
// its Google Fonts link dropped and its data-theme following the reader's
// Night or Dawn rather than the system the frame would otherwise take.
const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' }, viewport: {width: 1280, height: 800} });
const KEY = 'lotuspod:theme';
const LIGHT = 'rgb(246, 241, 231)';
const DARK = 'rgb(20, 32, 31)';
const document = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pump board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;display=swap" rel="stylesheet">
<style>
:root { --bg: #f6f1e7; --ink: #1d2a2c; --panel: #ffffff; --accent: #2f7d5b; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #14201f; --ink: #e8efe9; --panel: #1f2e2c; --accent: #7fd1a8; }
}
:root[data-theme="dark"] { --bg: #14201f; --ink: #e8efe9; --panel: #1f2e2c; --accent: #7fd1a8; }
body { margin: 0; padding: 32px; min-height: 520px; box-sizing: border-box; background: var(--bg); color: var(--ink); font: 16px Inter, system-ui, sans-serif; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.card { background: var(--panel); border-radius: 12px; padding: 20px; }
.card strong { display: block; font-size: 32px; color: var(--accent); }
</style>
</head>
<body>
<h1>Pump board</h1>
<p>North pond circulation, last hour</p>
<div class="cards">
  <div class="card">Flow<strong>42 L/min</strong></div>
  <div class="card">Pressure<strong>1.8 bar</strong></div>
  <div class="card">Intake<strong>Clear</strong></div>
</div>
</body>
</html>
`;
const notes = `## Operation

Run the circulation pump daily. Check the intake before starting.

## Review

Confirm the overnight schedule with the field team.
`;

function publish(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-pages-'));
  try {
    fs.writeFileSync(path.join(dir, name + '.html'), document);
    fs.writeFileSync(path.join(dir, 'notes.md'), notes);
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', path.join(dir, name + '.html'), '--artifact', '--notes', path.join(dir, 'notes.md'), '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments'], {env: {...env, PYTHONPATH: path.resolve(__dirname, '../../../../src')}, stdio: 'pipe'});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

test('an artifact pod follows the reader\'s Dawn and Night and takes comments on its notes', async ({page}) => {
  test.setTimeout(120000);
  publish('artifact-pump');
  const errors = watch(page);
  await page.goto('/');
  await page.evaluate((key) => localStorage.setItem(key, 'dawn'), KEY);
  await page.goto('/artifact-pump.html?standalone');
  await expect(page.locator('.artifact-header h1')).toHaveText('Pump board');
  const inner = page.frameLocator('iframe.artifact-widget');
  const root = inner.locator('html');
  const body = inner.locator('body');
  await expect(inner.getByRole('heading', {name: 'Pump board'})).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(body).toHaveCSS('background-color', LIGHT);
  await expect(page.locator('.artifact-live-badge').first()).toHaveText('Live');
  expect(await inner.locator('link').count()).toBe(0);
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Night', exact: true }).click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(body).toHaveCSS('background-color', DARK);
  await page.locator('details.artifact-comment[data-section="operation"] > summary').click();
  const panel = page.locator('aside.artifact-comments-panel');
  const field = panel.getByRole('textbox', {name: 'Comment on Operation', exact: true});
  await field.fill('The intake is clear.');
  await field.locator('xpath=ancestor::form').getByRole('button', {name: 'Comment', exact: true}).click();
  await expect(panel.locator('.artifact-comment-text').filter({hasText: 'The intake is clear.'})).toBeVisible();
  expect(errors).toEqual([]);
});
