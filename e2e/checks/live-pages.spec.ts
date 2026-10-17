import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const env = process.env;
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' }, viewport: {width: 1440, height: 900} });
const document = `<!DOCTYPE html><html lang="en"><head><title>Pump panel</title>
<style>body { padding: 32px; box-sizing: border-box; background: #182326; color: #edf4ee; min-height: 760px; font: 18px system-ui; } button { padding: 16px; font: inherit; background: #b7e4c7; border: 0; border-radius: 8px; } h1 { font-size: 42px; }</style></head><body>
<p>FIELD STATION / WATER SYSTEMS</p><h1>Pump panel</h1><p>North pond circulation</p><button>Start pump</button><p id="status">Ready · Standby</p>
<script>let count = 0; document.querySelector('button').onclick = () => { document.querySelector('#status').textContent = 'Running · ' + (++count); document.body.style.minHeight = '1200px'; };</script></body></html>`;
const notes = `# Notes title is ignored

## Operation

Run the circulation pump daily. Check the intake before starting.

## Review

Confirm the overnight schedule with the field team.

### Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| D1 | Run overnight? | Yes / No |
`;
function publish(name: string, text?: string, source = document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pages-'));
  try {
    fs.writeFileSync(path.join(dir, name + '.html'), source);
    fs.writeFileSync(path.join(dir, 'notes.md'), text ?? '');
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', path.join(dir, name + '.html'), '--live', '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments', ...(text === undefined ? [] : ['--notes', path.join(dir, 'notes.md')])], {env: {...env, PYTHONPATH: path.resolve(__dirname, '../../src')}});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('whole document runs below page chrome, comments post, notes swap preserves frame state', async ({page}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  publish('live-pump');
  await page.goto('/live-pump.html?standalone');
  await expect(page.locator('.artifact-topbar')).toBeVisible();
  await expect(page.locator('.artifact-header h1')).toHaveText('Pump panel');
  await expect(page.locator('.artifact-meta')).toBeVisible();
  await expect(page.locator('.artifact-header .artifact-comment-chip')).toBeVisible();
  const frame = page.locator('iframe.artifact-widget');
  const inner = page.frameLocator('iframe.artifact-widget');
  await expect(inner.getByRole('button')).toBeVisible();
  await inner.getByRole('button').click();
  await expect(inner.locator('#status')).toHaveText('Running · 1');
  await expect(frame).toHaveAttribute('height', '1200');
  // Notes appear in a fresh load; the subsequent republish changes notes only.
  publish('live-pump', notes);
  await page.goto('/live-pump.html?standalone&notes=1');
  await inner.getByRole('button').click();
  await expect(page.locator('#operation')).toBeVisible({timeout: 30000});
  await frame.evaluate(node => { (window as any).keptFrame = node; });
  for (const [section, label, text] of [['operation', 'Comment on Operation', 'The intake is clear.'], ['', 'Comment on this page', 'Ready for review.']]) {
    await page.locator(`details.artifact-comment[data-section="${section}"] > summary`).click();
    const panel = page.locator('aside.artifact-comments-panel');
    const field = panel.getByRole('textbox', {name: label, exact: true});
    await field.fill(text);
    await field.locator('xpath=ancestor::form').getByRole('button', {name: 'Comment', exact: true}).click();
    await expect(panel.locator('.artifact-comment-text').filter({hasText: text})).toBeVisible();
    await panel.getByRole('button', {name: 'Fold comments'}).click();
  }
  publish('live-pump', notes.replace('Run the circulation pump daily.', 'Run the circulation pump twice daily.'));
  await expect(page.locator('.artifact-body')).toContainText('twice daily', {timeout: 30000});
  expect(await frame.evaluate(node => node === (window as any).keptFrame)).toBe(true);
  await expect(inner.locator('#status')).toHaveText('Running · 1');
  expect(errors).toEqual([]);
});


test('a late head cannot bypass the widget policy', async ({page}) => {
  const requests: string[] = [];
  // Playwright emits request events even for CSP-blocked requests. Routing
  // observes only requests that actually reach the network layer.
  await page.route('https://policy-probe.invalid/**', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  const blocked = page.waitForEvent('requestfailed', request => request.url().includes('policy-probe.invalid'));
  publish('live-policy', undefined, `<!doctype html><html>text<head><title>Policy probe</title></head><body>
    <img src="https://policy-probe.invalid/image" onerror="document.body.dataset.escaped='yes'">
    <button onclick="document.body.dataset.escaped='yes'">Probe</button></body></html>`);
  await page.goto('/live-policy.html?standalone');
  const inner = page.frameLocator('iframe.artifact-widget');
  await inner.getByRole('button', {name: 'Probe'}).click();
  await expect(inner.locator('body')).not.toHaveAttribute('data-escaped', 'yes');
  expect(await inner.locator('head > :first-child').getAttribute('http-equiv')).toBe('Content-Security-Policy');
  expect((await blocked).failure()?.errorText).toMatch(/^(?:csp|net::ERR_BLOCKED_BY_CSP)$/);
  expect(requests).toEqual([]);
});
