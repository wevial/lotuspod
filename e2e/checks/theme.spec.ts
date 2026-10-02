import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

// Pages address the theme by a hash of its files. The helper tests/theme_change.py
// renders the page theme-change into the fixture's site from a copy of the
// theme whose stylesheet ends in one added comment; a reader loading that page
// fetches the changed stylesheet at a new address. Restoring renders the page
// from the packaged theme again, so no other check sees the change.
const NAME = 'theme-change';
const COMMENT = '\n/* theme change check: this rule set was changed */\n';
const PYTHON = process.env.LOTUSPOD_TEST_PYTHON ?? '';
const REPO = path.resolve(__dirname, '..', '..');
const PACKAGED_CSS = fs.readFileSync(
  path.join(REPO, 'src', 'lotuspod', '_theme', 'lotuspod.css'), 'utf-8');

function helper(...args: string[]) {
  execFileSync(PYTHON, ['-m', 'tests.theme_change', ...args], {
    cwd: REPO,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 60_000,
  });
}

// The address a page's stylesheet link names, read from the served page.
async function stylesheetHref(request: APIRequestContext, page: string): Promise<string> {
  const response = await request.get(`/${page}.html`);
  expect(response.status()).toBe(200);
  const found = (await response.text()).match(/<link rel="stylesheet" href="(lotuspod\.css\?v=[^"]*)">/);
  expect(found).not.toBeNull();
  return found![1];
}

function version(href: string): string {
  return new URL(href, 'http://site/').searchParams.get('v') ?? '';
}

test.describe('a theme edit reaches the reader at a new address', () => {
  test.beforeAll(() => {
    expect(PYTHON, 'LOTUSPOD_TEST_PYTHON names the fixture Python').not.toBe('');
  });

  test.afterAll(() => {
    helper('restore');
  });

  test('a page rendered from a changed stylesheet loads it at a new address', async ({ page, request }) => {
    const before = version(await stylesheetHref(request, 'capture-article'));
    expect(before).toMatch(/^[0-9a-f]{12}$/);

    helper('change', COMMENT);
    const stylesheet = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/lotuspod.css');
    await page.goto(`/${NAME}.html`);
    const response = await stylesheet;
    const changed = new URL(response.url()).searchParams.get('v') ?? '';
    expect(changed).toMatch(/^[0-9a-f]{12}$/);
    expect(changed).not.toBe(before);
    expect(response.status()).toBe(200);
    expect((await response.text()).endsWith(COMMENT)).toBe(true);

    helper('restore');
    const restored = await request.get(`/${await stylesheetHref(request, 'capture-article')}`);
    expect(restored.status()).toBe(200);
    expect(await restored.text()).toBe(PACKAGED_CSS);
  });
});
