import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

// The bottom sheet's History tab on a phone. Each check publishes a page of
// its own as hermes on the capture fixture's site with a real
// `lotuspod publish --local --comments`, in a new browser context, opens it,
// publishes it again with the pump's line changed and opens it once more.
// The sheet holds the comments panel's History tab beside Decisions and
// Comments, its nodes lent in while it shows and given back after.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page of two sections, with the pump's line as given, and one question.
function source(title: string, pump: string) {
  return [
    `# ${title}`, '', 'The plan for the pond this winter.', '',
    '## Pond', '', 'The pond freezes in January.', '',
    '## Pump', '', 'The pump sits by the steps.', pump, 'The fish sleep under the ice.', '',
    '## Decisions for the maintainer', '',
    '| # | Question | Options | Default |', '|---|---|---|---|',
    '| 1 | Which heater? | Floating / Submerged | Floating |', '',
  ].join('\n');
}

// hermes publishes markdown as the page name, with comments.
function publish(name: string, text: string) {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-history-narrow-'));
  try {
    const file = path.join(dir, `${name}.md`);
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
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: SIGNED_IN });
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

// Publishes the page, opens it, publishes it again with the pump's line
// changed and opens it once more. serve dates a page to the second: a
// publish in the second the page was served would leave the browser's
// cached copy current.
async function republish(page: Page, name: string) {
  publish(name, source('History sheet check', 'The pump stops in January.'));
  await open(page, name);
  await page.waitForTimeout(1100);
  publish(name, source('History sheet check', 'The pump runs all winter.'));
  await open(page, name);
}

function bottom(page: Page) {
  const node = page.locator('.artifact-comments-bottom-sheet');
  const tabs = node.getByRole('tablist');
  const history = node.locator('#artifact-comments-bottom-sheet-history');
  return {
    node,
    tabs,
    tab: (name: 'Decisions' | 'Comments' | 'History') => tabs.getByRole('tab', { name: new RegExp(`^${name}`) }),
    dot: node.locator('#artifact-comments-bottom-sheet-tab-history .artifact-comments-tab-dot'),
    close: node.getByRole('button', { name: 'Close', exact: true }),
    history,
    rows: history.locator('li.artifact-history-item'),
  };
}

// Opens the sheet with the title bar's count, then on History.
async function onHistory(page: Page) {
  const sheet = bottom(page);
  await page.locator('button.artifact-review-count').click();
  await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
  await sheet.tab('History').click();
  await expect(sheet.tab('History')).toHaveAttribute('aria-selected', 'true');
  return sheet;
}

test('the count opens the sheet with a History tab, which holds what changed, each diff and Mark as seen', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-narrow-check'));
    const count = page.locator('button.artifact-review-count');
    const kept = page.locator('aside.artifact-comments-panel #artifact-comments-history');
    await expect(count).toHaveText('1 to answer');
    const sheet = bottom(page);

    await count.click();
    await expect(sheet.node).toBeVisible();
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.tabs.getByRole('tab')).toHaveText([/^Decisions/, /^Comments/, /^History/]);
    await expect(sheet.dot).toHaveCount(1);
    await expect(sheet.tab('History')).toHaveAccessibleName(/^History.*, 1 section changed$/);

    await sheet.tab('History').click();
    await expect(sheet.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.tab('History')).toBeFocused();
    await expect(sheet.node).toHaveAttribute('aria-label', 'History');
    await expect(sheet.history).toBeVisible();
    await expect(sheet.history.getByRole('heading', { name: 'Since you last looked' })).toBeVisible();
    await expect(sheet.rows).toHaveCount(1);
    const row = sheet.rows.first();
    await expect(row.locator('.artifact-history-kind')).toHaveText('Changed');
    await expect(row.getByRole('link', { name: 'Pump' })).toBeVisible();
    await expect(kept.locator('*')).toHaveCount(0);

    // Show the diff and Mark as seen work in place: the nodes are the panel's.
    await row.getByRole('button', { name: 'Show the diff' }).click();
    await expect(row.locator('del.artifact-diff-line--removed .artifact-diff-text'))
      .toHaveText('The pump stops in January.');
    await expect(row.locator('ins.artifact-diff-line--added .artifact-diff-text'))
      .toHaveText('The pump runs all winter.');
    await sheet.history.getByRole('button', { name: 'Mark as seen' }).click();
    await expect(sheet.history).toContainText('Nothing new since you last looked.');
    await expect(sheet.dot).toHaveCount(0);
    await expect(sheet.tab('History')).toHaveAccessibleName(/^History$/);
    await expect(sheet.tab('History')).toBeFocused();

    // Closed, the sheet gives the tab back to the panel.
    await sheet.close.click();
    await expect(sheet.node).toBeHidden();
    await expect(count).toBeFocused();
    await expect(kept.locator('.artifact-history')).toHaveCount(1);
    await expect(sheet.history.locator('*')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the arrows cycle the sheet\'s tabs, and Comments shows the first section\'s way to comment', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-narrow-keys'));
    const sheet = await onHistory(page);

    await page.keyboard.press('ArrowRight');
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.tab('Decisions')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(sheet.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.tab('History')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(sheet.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.history.locator('.artifact-history')).toBeVisible();

    await sheet.tab('Comments').click();
    await expect(sheet.tab('Comments')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.history).toBeHidden();
    await expect(sheet.node.locator('.artifact-comments-held-title')).toHaveText('This page');
    await expect(sheet.node.getByRole('button', { name: 'Comment on this page' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('History moves between the sheet and the panel as the window widens and narrows', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-narrow-width'));
    const sheet = await onHistory(page);
    const aside = page.locator('aside.artifact-comments-panel');
    const kept = aside.locator('#artifact-comments-history');

    await page.setViewportSize(WIDE);
    await expect(sheet.node).toBeHidden();
    await expect(aside.locator('.artifact-comments-sheet')).toBeVisible();
    await expect(aside.getByRole('tab', { name: /^History/ })).toHaveAttribute('aria-selected', 'true');
    await expect(kept).toBeVisible();
    await expect(kept.getByRole('heading', { name: 'Since you last looked' })).toBeVisible();

    await page.setViewportSize(PHONE);
    await expect(sheet.node).toBeVisible();
    await expect(sheet.tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.history.getByRole('heading', { name: 'Since you last looked' })).toBeVisible();
    await expect(kept.locator('*')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a section\'s link in the sheet closes it before the page goes to the section', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-narrow-link'));
    const sheet = await onHistory(page);

    await sheet.rows.first().getByRole('link', { name: 'Pump' }).click();
    await expect(sheet.node).toBeHidden();
    await expect(page).toHaveURL(/#pump$/);
    await expect(page.locator('aside.artifact-comments-panel #artifact-comments-history .artifact-history'))
      .toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('on the narrowest phones every tab is whole, clear of Close, and a press away', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-narrow-small'));
    const sheet = bottom(page);
    await page.locator('button.artifact-review-count').click();
    await expect(sheet.tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: PHONE.height });
      // The tabs, the dot among them, that fall outside the strip or under Close.
      const outside = () => sheet.node.evaluate((node) => {
        const strip = node.querySelector('.artifact-comments-bottom-sheet-tabs')!.getBoundingClientRect();
        const close = node.querySelector('.artifact-comments-close')!.getBoundingClientRect();
        const end = Math.min(strip.right, close.left);
        return Array.from(node.querySelectorAll('[role="tab"], .artifact-comments-tab-dot')).filter((item) => {
          const box = item.getBoundingClientRect();
          return box.left < strip.left || box.right > end;
        }).map((item) => item.id || item.className);
      });
      await expect.poll(outside, { message: `at ${width} pixels` }).toEqual([]);
      for (const name of ['History', 'Comments', 'Decisions'] as const) {
        await sheet.tab(name).click();
        await expect(sheet.tab(name)).toHaveAttribute('aria-selected', 'true');
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
