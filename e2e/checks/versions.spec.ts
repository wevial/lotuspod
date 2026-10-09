import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// A page lists its earlier versions from the artifacts repository, and opens
// each one read-only. The capture fixture's site is the top of its own git
// repository, so each publish is a version: the first check publishes a page
// of its own twice with a real `lotuspod publish`; the fixture published
// capture-versions-once once and capture-versions-many 25 times. A page the
// reader opened before it was published again says what changed since: the
// changes checks publish pages of their own, open them, publish them again
// with one line changed and open them once more.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page's markdown: the edition named in its first paragraph, a section
// that takes comments and one question.
function source(title: string, edition: string) {
  return [
    `# ${title}`, '', `Edition: ${edition}.`, '',
    '## Pond', '', 'The pond freezes in January, and the pump stops with it.', '',
    '## Decisions for the maintainer', '',
    '| # | Question | Options | Default |', '|---|---|---|---|',
    '| 1 | Which heater? | Floating / Submerged | Floating |', '',
  ].join('\n');
}

// A page of two sections, with the pump's line as given.
function changesSource(title: string, pump: string) {
  return [
    `# ${title}`, '', 'The plan for the pond this winter.', '',
    '## Pond', '', 'The pond freezes in January.', '',
    '## Pump', '', 'The pump sits by the steps.', pump, 'The fish sleep under the ice.', '',
  ].join('\n');
}

// hermes publishes markdown as the page name, with comments.
function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-versions-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function view(page: Page) {
  const node = page.locator('section.artifact-versions');
  return {
    node,
    heading: node.getByRole('heading', { name: 'Versions' }),
    entries: node.locator('li.artifact-versions-entry'),
    more: node.getByRole('button', { name: 'Show older versions' }),
  };
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a page published twice lists two versions and opens the older one read-only', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'versions-check';
    publish(name, source('Versions check', 'first'));
    publish(name, source('Versions check', 'second'));

    await page.goto(`/${name}.html`);
    const link = page.locator('.artifact-header .artifact-meta a.artifact-versions-link');
    await expect(link).toHaveText('Versions · 2');
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html#versions$`));
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(versions.node).toContainText('2, newest first');
    await expect(page.locator('.artifact-body')).toBeHidden();
    await expect(versions.entries).toHaveCount(2);
    const times = await versions.entries.locator('time').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('datetime') ?? ''));
    expect(times[0] >= times[1]).toBe(true);
    await expect(versions.entries.nth(0).locator('.artifact-versions-current')).toHaveText('current');
    await expect(versions.entries.nth(0).getByRole('link')).toHaveCount(0);
    await expect(versions.entries.nth(1).locator('.artifact-versions-current')).toHaveCount(0);
    await expect(versions.more).toBeHidden();

    await versions.entries.nth(1).getByRole('link', { name: /^View/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?version=[0-9a-f]{40}$`));
    const banner = page.locator('main.artifact--old-version > div.artifact-version-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('1 version behind');
    await expect(page.locator('.artifact-body')).toContainText('Edition: first.');
    await expect(page.locator('.artifact-body')).not.toContainText('Edition: second.');
    const fieldsets = page.locator('form.artifact-decision fieldset');
    await expect(fieldsets).toHaveCount(1);
    await expect(fieldsets).toHaveAttribute('disabled', '');
    await expect(page.getByRole('radio', { name: 'Floating' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    await expect(page.locator('.artifact-version-note')).toContainText('Answering is off on old versions.');
    await expect(page.locator('details.artifact-comment').first()).toBeAttached();
    await expect(page.locator('details.artifact-comment:visible')).toHaveCount(0);
    await expect(page.locator('.artifact-versions-link')).toHaveCount(0);

    await banner.getByRole('link', { name: 'Back to current' }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html$`));
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(page.locator('.artifact-version-banner')).toHaveCount(0);

    await page.goBack();
    await expect(banner).toBeVisible();
    await banner.getByRole('link', { name: 'All versions' }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html#versions$`));
    await expect(view(page).heading).toBeVisible();
    await expect(view(page).entries).toHaveCount(2);

    // Leaving the view shows the page again.
    await view(page).node.getByRole('link', { name: 'Versions check' }).click();
    await expect(page.locator('.artifact-body')).toBeVisible();
    await expect(view(page).node).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a page published once is its only version', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/capture-versions-once.html');
    const link = page.locator('.artifact-versions-link');
    await expect(link).toHaveText('Versions · 1');
    await link.click();
    const versions = view(page);
    await expect(versions.node).toContainText('This is the only version.');
    await expect(versions.entries).toHaveCount(1);
    await expect(versions.entries.first()).toContainText('current');
    expect(errors).toEqual([]);
  });

  test('a page with 25 versions lists 20, then the other 5', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/capture-versions-many.html#versions');
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(versions.node).toContainText('25, newest first');
    await expect(versions.entries).toHaveCount(20);
    await expect(versions.more).toBeVisible();
    await versions.more.click();
    await expect(versions.entries).toHaveCount(25);
    await expect(versions.more).toBeHidden();
    await expect(versions.entries.locator('.artifact-versions-current')).toHaveCount(1);
    await expect(versions.entries.locator('a.artifact-versions-view')).toHaveCount(24);
    expect(errors).toEqual([]);
  });
});

test.describe('signed in, what changed', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  const BOX = 'section.artifact-changes';

  // Opens the page and waits until its versions link is drawn: by then the
  // page has heard what changed, so a box it would show is there.
  async function open(page: Page, name: string) {
    const seen = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/seen' && response.request().method() === 'POST');
    await page.goto(`/${name}.html`);
    expect((await seen).status()).toBe(200);
    await expect(page.locator('.artifact-versions-link')).toBeVisible();
  }

  test('a page republished since the reader opened it says what changed', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-check';
    publish(name, changesSource('Changes check', 'The pump stops in January.'));
    await open(page, name);
    await expect(page.locator(BOX)).toHaveCount(0);
    await expect(page.locator('.artifact-changed-tag')).toHaveCount(0);

    // serve dates a page to the second: a publish in the second the page was
    // served would leave the browser's cached copy current.
    await page.waitForTimeout(1100);
    publish(name, changesSource('Changes check', 'The pump runs all winter.'));
    await open(page, name);
    const box = page.locator(BOX);
    await expect(box.getByRole('heading', { name: 'What changed since you last looked' })).toBeVisible();
    await expect(box).toContainText('You last opened this on');
    await expect(box).toContainText('1 version ago');
    await expect(box.getByRole('link', { name: 'Pump' })).toHaveAttribute('href', '#pump');
    await expect(box.getByRole('link', { name: 'Pond' })).toHaveCount(0);
    await expect(page.locator('h2#pump .artifact-changed-tag')).toHaveText('changed');
    await expect(page.locator('.artifact-changed-tag')).toHaveCount(1);
    // The box sits between the header and the body.
    expect(await box.evaluate((node) =>
      node.previousElementSibling?.matches('header.artifact-header'))).toBe(true);

    await box.getByRole('link', { name: 'See the full diff' }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html#versions$`));
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(box).toBeHidden();
    const pane = versions.node.locator('aside.artifact-versions-diff');
    await expect(pane).toBeVisible();
    await expect(pane.getByRole('heading')).toContainText('→ current');
    await expect(pane.locator('del.artifact-diff-line--removed')).toHaveText(/The pump stops in January\./);
    await expect(pane.locator('ins.artifact-diff-line--added')).toHaveText(/The pump runs all winter\./);
    await expect(pane.locator('.artifact-diff-line--removed, .artifact-diff-line--added')).toHaveCount(2);
    await expect(versions.entries).toHaveCount(2);
    await expect(versions.entries.nth(1).locator('.artifact-versions-seen')).toHaveText('you last looked');
    await expect(versions.entries.nth(0).locator('.artifact-versions-seen')).toHaveCount(0);

    // The next load was seen at the page's own revision: nothing to say.
    await open(page, name);
    await expect(page.locator(BOX)).toHaveCount(0);
    await expect(page.locator('.artifact-changed-tag')).toHaveCount(0);
    await page.locator('.artifact-versions-link').click();
    await expect(view(page).heading).toBeVisible();
    await expect(page.locator('aside.artifact-versions-diff')).toHaveCount(0);
    await expect(page.locator('.artifact-versions-seen')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Dismiss removes the box', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-dismiss';
    publish(name, changesSource('Changes dismiss', 'The pump stops in January.'));
    await open(page, name);
    await expect(page.locator(BOX)).toHaveCount(0);
    await page.waitForTimeout(1100);
    publish(name, changesSource('Changes dismiss', 'The pump runs all winter.'));
    await open(page, name);
    const box = page.locator(BOX);
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator(BOX)).toHaveCount(0);
    await expect(page.locator('.artifact-body')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('signed in, outside a repository', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  // The fixture's site is a repository, so the route's answer for a
  // directory that is not one is stood in for: 200 with no versions.
  test('an empty list still shows "Versions · 0" and its view', async ({ page }) => {
    const errors = watchErrors(page);
    await page.route('**/api/versions?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ page: 'capture-versions-once', versions: [] }),
    }));
    await page.goto('/capture-versions-once.html');
    const link = page.locator('.artifact-header .artifact-meta a.artifact-versions-link');
    await expect(link).toHaveText('Versions · 0');
    await link.click();
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(versions.node).toContainText('This page has no versions yet.');
    await expect(versions.entries).toHaveCount(0);
    await expect(versions.more).toBeHidden();
    await expect(page.locator('.artifact-body')).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test('signed out, a page shows no versions', async ({ page }) => {
  const errors = watchErrors(page);
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/versions');
  await page.goto('/capture-versions-once.html');
  expect((await answered).status()).toBe(401);
  await expect(page.locator('.artifact-meta')).toBeVisible();
  await expect(page.locator('.artifact-versions-link')).toHaveCount(0);
  await expect(page.locator('section.artifact-versions')).toHaveCount(0);
  expect(errors).toEqual([]);
});
