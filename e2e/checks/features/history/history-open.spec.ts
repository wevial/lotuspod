import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

// The ways into the History tab: the title bar's "N changed" pill, shown
// while sections changed since the reader last looked are unseen, and the
// header's "Versions · N". Each check publishes a page of its own as hermes
// on the capture fixture's site with a real `lotuspod publish --local`, in a
// new browser context, opens it, publishes it again with the pump's line
// changed and opens it once more. A page with no comments panel has no
// History tab: there both go to the versions view.
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

// A page of two sections, with the pump's line as given, and one question
// unless asks is false.
function source(title: string, pump: string, asks = true) {
  return [
    `# ${title}`, '', 'The plan for the pond this winter.', '',
    '## Pond', '', 'The pond freezes in January.', '',
    '## Pump', '', 'The pump sits by the steps.', pump, 'The fish sleep under the ice.', '',
    ...(asks ? [
      '## Decisions for the maintainer', '',
      '| # | Question | Options | Default |', '|---|---|---|---|',
      '| 1 | Which heater? | Floating / Submerged | Floating |', '',
    ] : []),
  ].join('\n');
}

// hermes publishes markdown as the page name, with comments unless
// comments is false.
function publish(name: string, text: string, comments = true) {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-history-open-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, text, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, comments ? '--comments' : '--no-comments');
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

async function fresh(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: SIGNED_IN });
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
async function republish(page: Page, name: string, comments = true) {
  publish(name, source('History open check', 'The pump stops in January.', comments), comments);
  await open(page, name);
  await page.waitForTimeout(1100);
  publish(name, source('History open check', 'The pump runs all winter.', comments), comments);
  await open(page, name);
}

test('the title bar\'s "1 changed" opens the panel on History, and Mark as seen hides it', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser, WIDE);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-open-pill'));
    const bar = page.locator('.artifact-topbar');
    const pill = bar.locator('button.artifact-history-pill');
    const count = bar.locator('button.artifact-review-count');
    const aside = page.locator('aside.artifact-comments-panel');
    await expect(pill).toHaveText('1 changed');
    await expect(pill).toHaveAccessibleName('1 changed since you last looked: open History');
    await expect(count).toHaveText('1 to answer');
    const title = await bar.locator('.artifact-topbar-title').boundingBox();
    const box = await pill.boundingBox();
    const answer = await count.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
    expect(box!.x + box!.width).toBeLessThanOrEqual(answer!.x);
    await expect(aside.locator('.artifact-comments-sheet')).toBeHidden();

    await pill.click();
    const tab = aside.getByRole('tab', { name: /^History/ });
    const history = aside.locator('#artifact-comments-history');
    await expect(aside.locator('.artifact-comments-sheet')).toBeVisible();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toBeFocused();
    await expect(history.locator('li.artifact-history-item').getByRole('link', { name: 'Pump' })).toBeVisible();

    await history.getByRole('button', { name: 'Mark as seen' }).click();
    await expect(pill).toHaveCount(0);
    await open(page, own('history-open-pill'));
    await expect(count).toHaveText('1 to answer');
    await expect(page.locator('.artifact-history-pill')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('on a phone "1 changed" opens the bottom sheet on History, and Close gives the focus back', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser, PHONE);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-open-phone'));
    const pill = page.locator('.artifact-topbar button.artifact-history-pill');
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    const tab = sheet.getByRole('tab', { name: /^History/ });
    await expect(pill).toHaveText('1 changed');
    await expect(page.locator('button.artifact-review-count')).toHaveText('1 to answer');
    // The words show, rendered, and the bar's controls neither overlap nor
    // leave the window, down to the narrowest phones.
    for (const width of [360, 320, PHONE.width]) {
      await page.setViewportSize({ width, height: PHONE.height });
      expect(await pill.evaluate((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
        `at ${width} pixels`).toBe('1 changed');
      const clashes = await page.locator('.artifact-topbar').evaluate((bar) => {
        const boxes = Array.from(bar.querySelectorAll<HTMLElement>(
          '.artifact-history-pill, .artifact-archive, .artifact-review-next, .artifact-review-count, ' +
          '.artifact-copy-link, .artifact-theme-switch'))
          .filter((node) => node.offsetWidth > 0)
          .map((node) => ({ name: node.className, box: node.getBoundingClientRect() }));
        const found: string[] = [];
        boxes.forEach((one, at) => {
          if (one.box.left < 0 || one.box.right > window.innerWidth) found.push(`${one.name} leaves the window`);
          boxes.slice(at + 1).forEach((other) => {
            if (one.box.left < other.box.right && other.box.left < one.box.right &&
              one.box.top < other.box.bottom && other.box.top < one.box.bottom) {
              found.push(`${one.name} overlaps ${other.name}`);
            }
          });
        });
        return found;
      });
      expect(clashes, `at ${width} pixels`).toEqual([]);
    }

    await pill.click();
    await expect(sheet).toBeVisible();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toBeFocused();
    await expect(sheet.locator('#artifact-comments-bottom-sheet-history li.artifact-history-item'))
      .toHaveCount(1);

    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(pill).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the header\'s "Versions · 2" opens History at its versions, the address kept', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser, WIDE);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-open-link'));
    const aside = page.locator('aside.artifact-comments-panel');
    const history = aside.locator('#artifact-comments-history');
    await expect(aside.locator('.artifact-comments-sheet')).toBeHidden();

    await page.locator('header.artifact-header .artifact-versions-link').click();
    await expect(aside.getByRole('tab', { name: /^History/ })).toHaveAttribute('aria-selected', 'true');
    const heading = history.getByRole('heading', { name: 'Versions · 2' });
    await expect(heading).toBeVisible();
    const inside = await heading.evaluate((node) => {
      const area = node.closest('#artifact-comments-history')!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return box.top >= area.top && box.bottom <= area.bottom;
    });
    expect(inside).toBe(true);
    await expect(page.locator('section.artifact-versions')).toBeHidden();
    expect(new URL(page.url()).hash).not.toBe('#versions');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('on a page with no comments panel "1 changed" and "Versions · 2" open the versions view', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser, WIDE);
  try {
    const errors = watchErrors(page);
    const name = own('history-open-bare');
    await republish(page, name, false);
    await expect(page.locator('aside.artifact-comments-panel')).toHaveCount(0);
    const pill = page.locator('.artifact-topbar button.artifact-history-pill');
    await expect(pill).toHaveText('1 changed');

    await pill.click();
    await expect(page).toHaveURL(/#versions$/);
    await expect(page.locator('section.artifact-versions')).toBeVisible();
    await expect(page.locator('aside.artifact-versions-diff')).toBeVisible();

    await page.goBack();
    await expect(page.locator('section.artifact-versions')).toBeHidden();
    await page.locator('header.artifact-header .artifact-versions-link').click();
    await expect(page).toHaveURL(/#versions$/);
    await expect(page.locator('aside.artifact-versions-diff')).toBeVisible();

    // Opened again at the revision it last showed, nothing is unseen.
    await open(page, name);
    await expect(page.locator('.artifact-history-pill')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('"1 changed" pressed in the versions view leaves it for the panel\'s History', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser, WIDE);
  try {
    const errors = watchErrors(page);
    await republish(page, own('history-open-view'));
    await page.locator('#artifact-comments-history .artifact-history-all').evaluate((link: HTMLElement) => link.click());
    await expect(page.locator('section.artifact-versions')).toBeVisible();

    await page.locator('.artifact-topbar button.artifact-history-pill').click();
    await expect(page.locator('section.artifact-versions')).toBeHidden();
    expect(new URL(page.url()).hash).toBe('');
    const aside = page.locator('aside.artifact-comments-panel');
    await expect(aside.getByRole('tab', { name: /^History/ })).toHaveAttribute('aria-selected', 'true');
    await expect(aside.locator('#artifact-comments-history')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a question-only page whose answers could not be read sends "Versions · 2" to the versions view', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await fresh(browser, WIDE);
  try {
    const name = own('history-open-unread');
    publish(name, source('History open check', 'The pump stops in January.'), false);
    await open(page, name);
    await page.waitForTimeout(1100);
    publish(name, source('History open check', 'The pump runs all winter.'), false);
    await page.route('**/api/answers?*', (route) => route.fulfill({ status: 500, body: '' }));
    const errors = watchErrors(page);
    await open(page, name);
    await expect(page.locator('aside.artifact-comments-panel')).toBeHidden();

    await page.locator('header.artifact-header .artifact-versions-link').click();
    await expect(page).toHaveURL(/#versions$/);
    await expect(page.locator('aside.artifact-versions-diff')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
