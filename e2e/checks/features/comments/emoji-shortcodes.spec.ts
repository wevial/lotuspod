import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Emoji shortcodes in a comment composer: a partial `:shortcode:` opens a
// list of matching emoji under the field. The check renders its own page
// into the capture fixture's site, so the threads it posts are the only ones
// on it. At 1440 pixels a section's threads open in the panel.
const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

const NAME = 'check-emoji-shortcodes';
const PAGE = `/${NAME}.html`;
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const BODY = `<p>A page for the emoji shortcode checks.</p>
<h2>Pond</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice until the thaw.</p>
`;

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  execFileSync(PYTHON, [
    '-m', 'lotuspod', 'render', '--name', NAME, '--title', 'Check emoji shortcodes', '--comments',
    '--body', BODY, '--out-dir', OUT,
  ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
});

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('typing :tad in the panel\'s new thread composer lists 🎉 :tada: then 🏟️ :stadium:', async ({ page }) => {
    await page.goto(`${PAGE}?standalone`);
    await expect(page.locator(':root')).toHaveAttribute('data-lotuspod-comments-read', '');
    const aside = page.locator('aside.artifact-comments-panel');
    await aside.getByRole('button', { name: 'Comments', exact: true }).click();
    await aside.getByRole('button', { name: 'Comment on a section' }).click();
    await aside.getByRole('listbox', { name: 'Sections' }).getByRole('option', { name: 'Pond' }).click();
    const field = aside.getByLabel('Comment on Pond');
    await expect(field).toBeFocused();
    await field.pressSequentially('Looks great :tad');
    await expect(field).toHaveValue('Looks great :tad');

    const list = page.locator('ul[role="listbox"]').filter({ has: page.getByRole('option', { name: '🎉 :tada:' }) });
    await expect(list).toBeVisible();
    const options = list.getByRole('option');
    await expect(options.nth(0)).toHaveText('🎉 :tada:');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toHaveText('🏟️ :stadium:');
    await expect(field).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);
    await expect(field).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id'))!);
  });
});
