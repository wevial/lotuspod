import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

// A thread on a live block. The check publishes pages of its own as hermes on
// the capture fixture's site with a real `lotuspod publish`: one whose first
// section holds the block "churn". The reader starts a thread from the
// block's Comment; hermes claims and replies through real `lotuspod comments`
// commands on the fixture's agent socket; the page is published again with
// the block's script changed, then without the block, each swap applied in
// place. The run shares one database, so each repeat publishes pages of its
// own names.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
const WIDE = { width: 1440, height: 900 };
const TITLE = 'Merge churn by worker count';
const WORDS = `On ${TITLE}`;
const QUESTION = 'Reruns look high';
// The first comment names no agent, so it goes to the responder, whose
// thread hermes's credential may not claim: the reader asks hermes in it.
const ASK = '@hermes Is it the shared migration file?';
const REPLY = 'Mostly the shared migration file.';

// A page whose first section holds the block, drawn as version says; none
// at all when version is 0. Its second section keeps a block of its own, so
// taking churn away changes no policy and is swapped in place.
function doc(version: number) {
  const block = version ? ['```html live id=churn title="' + TITLE + '" height=160',
    `<p>Six workers: 21 merged a day, version ${version}.</p><script>document.body.dataset.version = '${version}';</script>`,
    '```', ''] : [];
  return ['# Merge study', '', 'How merges go as workers are added.', '',
    '## Churn', '', 'Reruns grow with the number of workers.', '', ...block,
    '## Notes', '', 'Nothing else yet.', '',
    '```html live id=tally title="Merged so far" height=120', '<p>Merged so far: 120.</p>', '```', ''].join('\n');
}

test.use({ viewport: WIDE, extraHTTPHeaders: SIGNED_IN });

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  return JSON.parse(run('comments', action, ...args, '--json',
    '--socket', SOCKET, '--credential', HERMES));
}

function publish(name: string, markdown: string, comments = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-block-comments-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, comments ? '--comments' : '--no-comments');
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

// Load a page on its own and wait for the block's chrome to be drawn.
async function load(page: Page, name: string) {
  await page.goto(`/${name}.html?standalone`);
  await expect(page.locator('figure[data-widget="churn"]').getByRole('button', { name: 'Pause', exact: true }))
    .toBeVisible();
}

// Publish the page again and apply the swap the page then finds.
async function swap(page: Page, name: string, markdown: string) {
  await page.evaluate(() => {
    (window as any).swapped = new Promise<void>((resolve) =>
      document.addEventListener('lotuspod:swapped', () => setTimeout(resolve), { once: true }));
  });
  publish(name, markdown);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.evaluate(() => (window as any).swapped);
}

function block(page: Page) {
  const figure = page.locator('figure[data-widget="churn"]');
  return {
    figure,
    comment: figure.locator('.artifact-live-chrome').getByRole('button', { name: 'Comment', exact: true }),
    pin: figure.locator(':scope > .artifact-live-pin'),
  };
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  const group = (title: string) => aside.locator('.artifact-comments-group')
    .filter({ has: page.locator(':scope > .artifact-comments-group-title', { hasText: title }) });
  return { aside, group, strays: aside.locator('.artifact-comments-group').last() };
}

// The comment the page posts next, as the route receives it.
function posting(page: Page): Promise<Request> {
  return page.waitForRequest((request) => new URL(request.url()).pathname === '/api/comments' &&
    request.method() === 'POST' && 'text' in (request.postDataJSON() ?? {}));
}

async function hashOf(page: Page) {
  const source = await block(page).figure.locator('iframe.artifact-widget').getAttribute('src');
  const hash = /\.w-([0-9a-f]{12})\.html$/.exec(source ?? '')?.[1];
  expect(hash, `the frame's src ${source} names its widget file's hash`).toBeTruthy();
  return hash!;
}

test('a reader comments on a live block, hermes answers, and the thread follows the block as it changes and goes', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  const name = `block-comments-check-${test.info().repeatEachIndex}`;
  publish(name, doc(1));
  // hermes pulls first, so it is listening and the comment waits for it.
  hermes('pull', '--owner', OWNER);
  const errors = watch(page);
  await load(page, name);
  const live = block(page);
  const side = panel(page);
  const churn = side.group('Churn');
  const hash = await hashOf(page);

  // The Comment follows the title and badge, and the pin waits for a thread.
  expect(await live.figure.locator('.artifact-live-chrome > *').evaluateAll((nodes) =>
    nodes.map((node) => node.className))).toEqual(['artifact-live-title', 'artifact-live-badge',
    'artifact-live-comment', 'artifact-live-expand', 'artifact-live-open', 'artifact-live-pause']);
  await expect(live.pin).toBeHidden();

  await live.comment.click();
  const form = churn.locator('form.artifact-comment-form');
  await expect(churn.locator('.artifact-comment-on')).toHaveText(WORDS);
  const field = form.locator('textarea[name="text"]');
  await expect(field).toBeFocused();
  await field.fill(QUESTION);
  const sent = posting(page);
  await form.getByRole('button', { name: 'Comment', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.widget).toEqual({ id: 'churn', hash, state: '' });
  expect(body.section).toBe('churn');
  expect(body.text).toBe(QUESTION);

  const entry = churn.locator('.artifact-comments-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-words')).toHaveText(WORDS);
  await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-mark')).toHaveText('▣');
  await expect(churn.locator('.artifact-comment-on')).toHaveCount(0);
  await expect(live.pin).toBeVisible();
  await expect(live.pin).toHaveText('1');
  const id = Number(await entry.getAttribute('data-thread'));

  // hermes claims and answers; the panel's next read shows the reply.
  const thread = entry.locator(`.artifact-comment-thread[data-thread="${id}"]`);
  await thread.getByRole('button', { name: 'Add to your comment' }).click();
  await thread.locator('form.artifact-comment-reply textarea').fill(ASK);
  const asked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await thread.locator('form.artifact-comment-reply').getByRole('button', { name: 'Send' }).click();
  const ask = (await (await asked).json()).id as number;
  const claim = hermes('claim', String(ask));
  expect(claim.handle).toBe(OWNER);
  // A claim token may start with '-': give it to its option in one word.
  hermes('reply', String(ask), `--claim=${claim.claimToken}`, '--key', `block-comments-${ask}`, '--text', REPLY);
  await expect(entry.locator('.artifact-comment-item--agent .artifact-comment-text')).toHaveText(REPLY, { timeout: 45_000 });
  await expect(live.pin).toHaveText('1');

  // Resolved, the block has no open thread; reopened, it has one again.
  await entry.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(live.pin).toBeHidden();
  await side.aside.getByRole('button', { name: /^Show resolved/ }).click();
  await entry.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(live.pin).toHaveText('1');
  await expect(live.pin).toBeVisible();

  // Pressing the pin opens the block's thread.
  await entry.locator('.artifact-comments-entry-head').click();
  await expect(entry.locator('.artifact-comments-entry-body')).toBeHidden();
  await live.pin.click();
  await expect(entry.locator('.artifact-comments-entry-body')).toBeVisible();

  // The block's script changes under the same id: the thread stays on it.
  await swap(page, name, doc(2));
  await expect(page.frameLocator('figure[data-widget="churn"] iframe').locator('body'))
    .toHaveAttribute('data-version', '2');
  expect(await hashOf(page)).not.toBe(hash);
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-words')).toHaveText(WORDS);
  const changed = entry.locator('.artifact-comment-event--widget');
  await expect(changed).toHaveText('Widget changed since this comment');
  await expect(changed).toBeVisible();
  // Under the first comment, before the reply.
  expect(await entry.locator('.artifact-comment-list > li').evaluateAll((rows) => rows.map((row) =>
    row.classList.contains('artifact-comment-event--widget') ? 'changed'
      : row.classList.contains('artifact-comment-item--agent') ? 'agent'
      : row.classList.contains('artifact-comment-item--reader') ? 'reader' : null).filter(Boolean)))
    .toEqual(['reader', 'changed', 'reader', 'agent']);
  await expect(block(page).pin).toHaveText('1');

  // The block is taken away: its thread goes with what the page no longer has.
  await swap(page, name, doc(0));
  await expect(page.locator('figure[data-widget="churn"]')).toHaveCount(0);
  const moved = side.strays.locator(`.artifact-comments-entry[data-thread="${id}"]`);
  await expect(moved).toHaveCount(1);
  await expect(side.strays).toBeVisible();
  await expect(moved.locator('.artifact-comments-entry-words').first()).toHaveText('On churn');
  await expect(churn.locator('.artifact-comments-entry')).toHaveCount(0);
  await expect(page.locator('figure[data-widget="tally"]')).toHaveCount(1);
  await expect(page.locator('.artifact-live-pin:visible')).toHaveCount(0);

  // A fresh load lists it there too.
  await page.goto(`/${name}.html?standalone`);
  await expect(side.strays.locator(`.artifact-comments-entry[data-thread="${id}"]`)).toHaveCount(1);
  await expect(side.group('Churn').locator('.artifact-comments-entry')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Escape drops the block from the composer, and the section's own box then sends no widget", async ({ page }) => {
  const name = `block-comments-escape-${test.info().repeatEachIndex}`;
  publish(name, doc(1));
  const errors = watch(page);
  await load(page, name);
  const live = block(page);
  const churn = panel(page).group('Churn');
  const form = churn.locator('form.artifact-comment-form');

  await live.comment.click();
  await expect(churn.locator('.artifact-comment-on')).toHaveText(WORDS);
  await expect(form.locator('textarea[name="text"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(churn.locator('.artifact-comment-on')).toHaveCount(0);

  await page.locator('details.artifact-comment[data-section="churn"] > summary').click();
  await expect(form).toBeVisible();
  await expect(churn.locator('.artifact-comment-on')).toHaveCount(0);
  await form.locator('textarea[name="text"]').fill('A note on the section');
  const sent = posting(page);
  await form.getByRole('button', { name: 'Comment', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.section).toBe('churn');
  expect('widget' in body).toBe(false);
  const entry = churn.locator('.artifact-comments-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-mark')).toHaveText('§');
  await expect(live.pin).toBeHidden();
  expect(errors).toEqual([]);
});

test('an archived page and a page without comments give the block no Comment', async ({ page }) => {
  const archived = `block-comments-archived-${test.info().repeatEachIndex}`;
  const plain = `block-comments-plain-${test.info().repeatEachIndex}`;
  publish(archived, doc(1));
  publish(plain, doc(1), false);
  const errors = watch(page);
  expect(run('archive', archived, '--local', '--out-dir', OUT)).toContain(`archived ${archived}`);
  try {
    await load(page, archived);
    await expect(page.locator('meta[name="lotuspod:archived"]')).toHaveCount(1);
    await expect(block(page).figure.locator('.artifact-live-chrome button')).toHaveText(['Expand', 'Pause']);
    await expect(block(page).comment).toHaveCount(0);
  } finally {
    run('unarchive', archived, '--local', '--out-dir', OUT);
  }
  await load(page, plain);
  await expect(page.locator('details.artifact-comment')).toHaveCount(0);
  await expect(block(page).figure.locator('.artifact-live-chrome button')).toHaveText(['Expand', 'Pause']);
  await expect(block(page).comment).toHaveCount(0);
  expect(errors).toEqual([]);
});
