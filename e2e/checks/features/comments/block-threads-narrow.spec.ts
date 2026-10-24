import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// A thread on a live block, opened where there is no room for the comments
// panel: at 800 pixels in a popover, at 390 in the bottom sheet. The check
// publishes pages of its own as hermes on the capture fixture's site with a
// real `lotuspod publish`, whose section Churn holds the block "churn", and
// posts a thread on the block and a plain one on Churn through the reader's
// /api/comments. The run shares one database, so each repeat publishes pages
// of its own names.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const MEDIUM = { width: 800, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = 'Merge churn by worker count';
const STATE = 'at 6 workers';
const WORDS = `On ${TITLE} · ${STATE}`;
const ON_BLOCK = 'Reruns look high at six';
const ON_SECTION = 'The prose undersells it';

const DOC = ['# Merge study', '', 'How merges go as workers are added.', '',
  '## Churn', '', 'Reruns grow with the number of workers.', '',
  '```html live id=churn title="' + TITLE + '" height=160',
  '<p>Six workers: 21 merged a day.</p>', '```', '',
  '## Notes', '', 'Nothing else yet.', ''].join('\n');

test.use({ viewport: MEDIUM, extraHTTPHeaders: SIGNED_IN });

// The page polls /api/comments; a poll still in a route handler's route.fetch
// when a check ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-block-threads-narrow-'));
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

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function block(page: Page) {
  const figure = page.locator('figure[data-widget="churn"]');
  return { figure, pin: figure.locator(':scope > .artifact-live-pin') };
}

async function load(page: Page, name: string) {
  await page.goto(`/${name}.html?standalone`);
  await expect(block(page).figure.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
}

async function hashOf(page: Page) {
  const source = await block(page).figure.locator('iframe.artifact-widget').getAttribute('src');
  const hash = /\.w-([0-9a-f]{12})\.html$/.exec(source ?? '')?.[1];
  expect(hash, `the frame's src ${source} names its widget file's hash`).toBeTruthy();
  return hash!;
}

async function post(page: Page, name: string, text: string, widget?: object) {
  const response = await page.request.post('/api/comments', {
    headers: SIGNED_IN,
    data: { page: name, section: 'churn', text, ...(widget ? { widget } : {}) },
  });
  expect(response.status()).toBe(201);
}

function held(page: Page, kind: 'popover' | 'bottom-sheet') {
  const node = page.locator(`.artifact-comments-${kind}`);
  return {
    node,
    title: node.locator('.artifact-comments-held-title'),
    forth: node.getByRole('button', { name: 'Next thread' }),
    back: node.getByRole('button', { name: 'Previous thread' }),
    entry: (text: string) => node.locator('.artifact-comments-entry').filter({ hasText: text }),
  };
}

// A page with a thread on the block (in the state given) and a plain one on
// Churn, loaded again so both are drawn.
async function setUp(page: Page, name: string, state: string) {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  publish(name, DOC);
  await load(page, name);
  await post(page, name, ON_BLOCK, { id: 'churn', hash: await hashOf(page), state });
  await post(page, name, ON_SECTION);
  await load(page, name);
  await expect(block(page).pin).toHaveText('1');
}

test('a block thread names its block in the popover its pin opens', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `block-threads-narrow-${test.info().repeatEachIndex}`;
  const errors = watch(page);
  await setUp(page, name, STATE);
  const over = held(page, 'popover');

  await block(page).pin.click();
  await expect(over.node).toBeVisible();
  await expect(over.title).toHaveText(WORDS);
  await expect(over.title.locator('span.artifact-comments-entry-block')).toHaveText(TITLE);
  await expect(over.node).toHaveAttribute('aria-label', WORDS);
  expect(errors).toEqual([]);
});

test("a section chip's popover leads a block thread's entry with the block it is on", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `block-threads-chip-${test.info().repeatEachIndex}`;
  const errors = watch(page);
  await setUp(page, name, STATE);
  const over = held(page, 'popover');

  await page.locator('details.artifact-comment[data-section="churn"] > summary').click();
  await expect(over.node).toBeVisible();
  await expect(over.title).toHaveText('Section Churn');
  await expect(over.node.locator('.artifact-comments-entry')).toHaveCount(2);
  // The entry's head, where the panel's words are, is hidden in a popover.
  await expect(over.entry(ON_BLOCK).getByText(WORDS, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(over.entry(ON_SECTION).getByText(/^On /).filter({ visible: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a block thread names its block in the bottom sheet, and the title follows the arrows', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `block-threads-sheet-${test.info().repeatEachIndex}`;
  const errors = watch(page);
  await page.setViewportSize(PHONE);
  await setUp(page, name, STATE);
  const bottom = held(page, 'bottom-sheet');

  await block(page).pin.click();
  await expect(bottom.node).toBeVisible();
  await expect(bottom.title).toHaveText(WORDS);
  await bottom.forth.click();
  await expect(bottom.title).toHaveText('Section Churn');
  await bottom.back.click();
  await expect(bottom.title).toHaveText(WORDS);
  expect(errors).toEqual([]);
});

test('a block thread with no state is titled by its block alone', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `block-threads-stateless-${test.info().repeatEachIndex}`;
  const errors = watch(page);
  await setUp(page, name, '');
  const over = held(page, 'popover');

  await block(page).pin.click();
  await expect(over.node).toBeVisible();
  await expect(over.title).toHaveText(`On ${TITLE}`);
  expect(errors).toEqual([]);
});
