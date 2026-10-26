import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// An earlier version serve cannot draw in today's shell (a revision committed
// without its kept source, its body holding comment boxes) is answered from
// its published file, running today's theme head: it takes the reader's theme
// from the first paint, and its title bar's theme switch and Copy link work.
const env = process.env;
const NAME = 'old-version-published-theme';
const SRC = path.resolve(__dirname, '../../../../src');
test.use({
  colorScheme: 'dark',
  extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': env.LOTUSPOD_TEST_ASSERTION ?? '' },
});

function publish(edition: string, ...argv: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), NAME));
  try {
    const file = path.join(dir, `${NAME}.md`);
    fs.writeFileSync(file, `# Pond\n\nThe ${edition} edition.\n\n## Depth\n\nTwo metres.\n`);
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', ...argv],
      { env: { ...env, PYTHONPATH: SRC } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The first revision as a page published before sources were kept: published
// with comment boxes elsewhere, its page file alone committed to the site.
function commitPageOnly(edition: string): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME}-scratch`));
  const out = env.LOTUSPOD_TEST_OUT!;
  try {
    publish(edition, '--comments', '--out-dir', scratch);
    fs.copyFileSync(path.join(scratch, `${NAME}.html`), path.join(out, `${NAME}.html`));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  const git = (...argv: string[]) => execFileSync('git', ['-C', out, ...argv], { encoding: 'utf-8' });
  git('add', '--', `${NAME}.html`);
  git('commit', '-q', '-m', 'A page published before sources were kept', '--', `${NAME}.html`);
  return git('rev-parse', 'HEAD').trim();
}

function theme(page: Page, name: 'Dawn' | 'Auto') {
  return page.getByRole('group', { name: 'Theme' }).getByRole('button', { name, exact: true });
}

test('an earlier version answered as published follows the theme switch and copies its link', async ({ page, context, baseURL }) => {
  for (const [key, value] of Object.entries({ OUT: env.LOTUSPOD_TEST_OUT, PYTHON: env.LOTUSPOD_TEST_PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  // Its own edition each attempt, so a retry commits a change of its own.
  const first = commitPageOnly(`first (${Date.now()})`);
  publish('second', '--out-dir', env.LOTUSPOD_TEST_OUT!, '--owner', 'hermes',
    '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!);

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const address = `/${NAME}.html?version=${first}`;
  const response = await page.goto(address);
  expect(response!.status()).toBe(200);
  expect(response!.headers()['etag']).toBeUndefined();
  await expect(page.locator('.artifact-version-banner')).toBeVisible();
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'night');
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
  await expect(theme(page, 'Auto')).toHaveAttribute('aria-pressed', 'true');

  const background = () => page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
  const night = await background();
  await theme(page, 'Dawn').click();
  await expect(root).toHaveAttribute('data-theme', 'dawn');
  await expect.poll(background).not.toBe(night);
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dawn');
  await expect(theme(page, 'Dawn')).toHaveAttribute('aria-pressed', 'true');

  const copy = page.getByRole('button', { name: 'Copy link' });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveAttribute('data-copied', '');
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${new URL(baseURL!).origin}${address}`);
  expect(errors).toEqual([]);
});
