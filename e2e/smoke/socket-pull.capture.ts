import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Visual evidence for the unchanged reader experience after a socket pull.
// tests.features.agents.test_pull_catalog supplies the allow-list read-count evidence.
const ENV = process.env;
const COMMENT = '@hermes Which heater fits beside the pump?';
test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION ?? '' } });

function pull() {
  return JSON.parse(execFileSync(ENV.LOTUSPOD_TEST_PYTHON!, [
    '-m', 'lotuspod', 'comments', 'pull', '--owner', 'hermes', '--json',
    '--socket', ENV.LOTUSPOD_TEST_SOCKET!, '--credential', ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES!,
  ], {
    encoding: 'utf-8', timeout: 60_000,
    env: { ...ENV, PYTHONPATH: path.resolve(__dirname, '../../src') },
  }));
}

test('a reader comment reaches the agent through its socket pull', async ({ page }) => {
  for (const name of ['CAPTURE_OUT', 'LOTUSPOD_TEST_PYTHON', 'LOTUSPOD_TEST_SOCKET',
    'LOTUSPOD_TEST_CREDENTIAL_HERMES', 'LOTUSPOD_TEST_ASSERTION']) {
    expect(ENV[name], `the capture fixture supplies ${name}`).toBeTruthy();
  }
  pull(); // Register the listening handle before the reader comments.
  await page.goto('/capture-owned.html?standalone');
  await expect(page.getByText('Published by hermes')).toBeVisible();
  await page.locator('details.artifact-comment[data-section="heater"] > summary').click();
  const group = page.locator('.artifact-comments-group').filter({
    has: page.locator('.artifact-comments-group-title', { hasText: 'Heater' }),
  });
  await group.locator('textarea[name="text"]').fill(COMMENT);
  await group.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(group.locator('.artifact-comment-text')).toHaveText(COMMENT);
  const items = pull().items.filter((item: any) => item.page.name === 'capture-owned');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'comment', comment: { text: COMMENT, owner: 'hermes' } });
  await expect(group.locator('.artifact-comment-typing--pending')).toContainText('Checking for a reply from hermes');
  await page.screenshot({ path: path.join(ENV.CAPTURE_OUT!, '01-reader-comment-pulled.png'), fullPage: true });
});
