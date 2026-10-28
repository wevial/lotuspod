import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

// The comments panel's History tab on a wide window. Each check publishes
// pages of its own as hermes on the capture fixture's site with a real
// `lotuspod publish --local --comments`, in a new browser context, so the
// panel starts folded. A page the reader opened before it was published
// again marks History with a dot, and the folded rail with a sky mark; the
// tab says what changed, each changed section's diff a press away, beside
// the newest versions, and Mark as seen clears it for the load.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const PANEL = 'lotuspod:comments-panel';
const WIDE = { width: 1280, height: 800 };

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page of two sections, with the pump's line as given.
function changesSource(title: string, pump: string) {
  return [
    `# ${title}`, '', 'The plan for the pond this winter.', '',
    '## Pond', '', 'The pond freezes in January.', '',
    '## Pump', '', 'The pump sits by the steps.', pump, 'The fish sleep under the ice.', '',
  ].join('\n');
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

// An HTML page with no h2, published as it is written.
function embedded(title: string, pump: string) {
  return [
    '<div data-page="capture-versions-many">Embedded.</div>',
    `<h1>${title}</h1>`, '<p>The plan for the pond this winter.</p>',
    `<p>The pump sits by the steps. ${pump}</p>`, '',
  ].join('\n');
}

// hermes publishes markdown, or HTML with suffix .html, as the page name,
// with comments.
function publish(name: string, text: string, suffix = '.md') {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-history-tab-'));
  try {
    const file = path.join(dir, `${name}${suffix}`);
    fs.writeFileSync(file, text, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A page name of this check's own, as the site keeps what each reader saw.
function own(base: string) {
  return `${base}-${test.info().repeatEachIndex}-${test.info().retry}`;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function fresh(browser: Browser) {
  const context = await browser.newContext({ viewport: WIDE, extraHTTPHeaders: SIGNED_IN });
  return { context, page: await context.newPage() };
}

// Opens the page and waits until its versions link is drawn: by then the
// page has heard the versions route and what changed.
async function open(page: Page, name: string) {
  const seen = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/seen' && response.request().method() === 'POST');
  await page.goto(`/${name}.html?standalone`);
  expect((await seen).status()).toBe(200);
  await expect(page.locator('.artifact-versions-link')).toBeVisible();
}

// Publishes the page, opens it, publishes it again with its text changed
// and opens it once more. serve dates a page to the second: a publish in the
// second the page was served would leave the browser's cached copy current.
async function republish(page: Page, name: string, first: string, second: string, suffix = '.md') {
  publish(name, first, suffix);
  await open(page, name);
  await page.waitForTimeout(1100);
  publish(name, second, suffix);
  await open(page, name);
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  const tabs = aside.getByRole('tablist');
  const history = aside.locator('#artifact-comments-history');
  return {
    aside,
    tabs,
    tab: (name: 'Decisions' | 'Comments' | 'History') => tabs.getByRole('tab', { name: new RegExp(`^${name}`) }),
    dot: aside.locator('#artifact-comments-tab-history .artifact-comments-tab-dot'),
    sheet: aside.locator('.artifact-comments-sheet'),
    rail: aside.locator('.artifact-comments-rail'),
    opener: aside.locator('.artifact-comments-rail .artifact-comments-opener'),
    mark: aside.locator('.artifact-comments-rail button.artifact-comments-rail-history'),
    fold: aside.locator('button.artifact-comments-fold'),
    history,
    rows: history.locator('li.artifact-history-item'),
    entries: history.locator('li.artifact-versions-entry'),
  };
}

test('a page changed since the reader looked marks History, which says what changed, lists the versions and marks it seen', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    const name = own('history-tab-check');
    await republish(page, name, changesSource('History tab check', 'The pump stops in January.'),
      changesSource('History tab check', 'The pump runs all winter.'));
    const side = panel(page);

    // Folded as it was, the rail carries the History mark; nothing opens
    // History by itself.
    await expect(side.mark).toBeVisible();
    await expect(side.mark).toHaveAttribute('aria-label', 'Changed since you last looked: open History');
    await expect(side.sheet).toBeHidden();
    await side.opener.click();
    await expect(side.tab('Comments')).toHaveAttribute('aria-selected', 'true');
    await expect(side.tabs.getByRole('tab')).toHaveText([/^Comments/, /^History/]);
    await expect(side.dot).toHaveCount(1);
    await expect(side.tab('History').locator('.artifact-comments-tab-unseen')).toHaveText(', 1 section changed');
    await expect(side.tab('History')).toHaveAccessibleName(/^History.*, 1 section changed$/);
    await side.fold.click();
    await side.mark.click();
    await expect(side.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(side.tab('History')).toBeFocused();
    await expect(side.history).toBeVisible();

    // What changed since the last visit.
    await expect(side.history.getByRole('heading', { name: 'Since you last looked' })).toBeVisible();
    await expect(side.history).toContainText('You last opened this on');
    await expect(side.history).toContainText('1 version ago');
    await expect(side.rows).toHaveCount(1);
    const row = side.rows.first();
    await expect(row.locator('.artifact-history-kind')).toHaveText('Changed');
    await expect(row.getByRole('link', { name: 'Pump' })).toHaveAttribute('href', '#pump');
    await expect(side.rows.filter({ hasText: 'Pond' })).toHaveCount(0);
    const toggle = row.locator('button.artifact-history-toggle');
    await expect(toggle).toHaveText('Show the diff');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(row.locator('.artifact-diff-line')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveText('Hide the diff');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(row.locator('.artifact-diff-line--removed, .artifact-diff-line--added')).toHaveCount(2);
    await expect(row.locator('del.artifact-diff-line--removed .artifact-diff-text'))
      .toHaveText('The pump stops in January.');
    await expect(row.locator('ins.artifact-diff-line--added .artifact-diff-text'))
      .toHaveText('The pump runs all winter.');

    // The versions, newest first, as the versions route lists them.
    await expect(side.history.getByRole('heading', { name: 'Versions · 2' })).toBeVisible();
    await expect(side.entries).toHaveCount(2);
    const answered = await page.request.get(`/api/versions?page=${name}`);
    expect(answered.status()).toBe(200);
    const [newest, older] = (await answered.json()).versions;
    expect(newest.current).toBe(true);
    await expect(side.entries.nth(0).locator('.artifact-versions-current')).toHaveText('current');
    await expect(side.entries.nth(0).locator('.artifact-versions-seen')).toHaveCount(0);
    await expect(side.entries.nth(1).locator('.artifact-versions-seen')).toHaveText('you last looked');
    await expect(side.entries.nth(1).getByRole('link', { name: 'View' }))
      .toHaveAttribute('href', new RegExp(`\\?version=${older.commit}$`));
    await side.history.getByRole('link', { name: 'See all versions' }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#versions$`));
    await expect(page.locator('section.artifact-versions').getByRole('heading', { name: 'Versions' })).toBeVisible();
    await page.goBack();
    await expect(side.history).toBeVisible();

    // Mark as seen clears the list, the dot and the mark, and posts nothing.
    const posted: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posted.push(new URL(request.url()).pathname);
    });
    await side.history.getByRole('button', { name: 'Mark as seen' }).click();
    await expect(side.history).toContainText('Nothing new since you last looked.');
    await expect(side.rows).toHaveCount(0);
    await expect(side.history.getByRole('button', { name: 'Mark as seen' })).toHaveCount(0);
    await expect(side.dot).toHaveCount(0);
    await expect(side.tab('History').locator('.artifact-comments-tab-unseen')).toHaveCount(0);
    await expect(side.mark).toHaveCount(0);
    await expect(side.entries.nth(0).locator('.artifact-versions-seen')).toHaveText('you last looked');
    await expect(side.entries.nth(1).locator('.artifact-versions-seen')).toHaveCount(0);
    await expect(side.tab('History')).toBeFocused();
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);

    // The visit was recorded as the page loaded: the next has nothing new.
    await open(page, name);
    await expect(side.tab('History')).toBeVisible();
    await expect(side.dot).toHaveCount(0);
    await expect(side.mark).toHaveCount(0);
    await side.tab('History').click();
    await expect(side.history).toContainText('Nothing new since you last looked.');
    await expect(side.rows).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('on a page that asks a question the tabs are Decisions, Comments and History, and the arrows cycle them', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    const name = own('history-tab-asks');
    publish(name, source('History tab asks', 'first'));
    await page.waitForTimeout(1100);
    publish(name, source('History tab asks', 'second'));
    await page.addInitScript(([key]) => {
      if (!sessionStorage.getItem('__remembered')) {
        sessionStorage.setItem('__remembered', '1');
        localStorage.setItem(key, 'open');
      }
    }, [PANEL]);
    await open(page, name);
    const side = panel(page);
    await expect(side.tab('History')).toBeVisible();
    await expect(side.tabs.getByRole('tab')).toHaveText([/^Decisions/, /^Comments/, /^History/]);
    await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');

    await side.tab('History').click();
    await expect(side.tab('History')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await expect(side.tab('Decisions')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(side.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(side.tab('History')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(side.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(side.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(side.history).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('an HTML page changed since the reader looked lists its text with no diff to show', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    const name = own('history-tab-html');
    await republish(page, name, embedded('History tab html', 'The pump stops in January.'),
      embedded('History tab html', 'The pump runs all winter.'), '.html');
    const side = panel(page);
    await side.mark.click();
    await expect(side.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(side.rows).toHaveCount(1);
    await expect(side.rows.first().locator('.artifact-history-kind')).toHaveText('Changed');
    await expect(side.rows.first().locator('button.artifact-history-toggle')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('signed out, a page has no History tab', async ({ browser }) => {
  test.setTimeout(60_000);
  const name = own('history-tab-signed-out');
  publish(name, changesSource('History tab signed out', 'The pump stops in January.'));
  const context = await browser.newContext({ viewport: WIDE });
  try {
    const page = await context.newPage();
    const errors = watchErrors(page);
    const answered = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/versions');
    await page.goto(`/${name}.html?standalone`);
    expect((await answered).status()).toBe(401);
    await expect(page.locator('.artifact-meta')).toBeVisible();
    await expect(page.locator('#artifact-comments-tab-history')).toHaveCount(0);
    await expect(page.locator('button.artifact-comments-rail-history')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
