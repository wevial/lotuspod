import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The README's pictures: the sample plan page (tests/fixtures/readme/plan.md)
// published as hermes into the capture fixture's site, then, at 1280 by 800,
// a section comment hermes answers through real `lotuspod comments` commands,
// the decision form answered, and a comment on a passage. One video records
// the three; docs/development.md turns it into the README's GIF. Writes
// thread.png, decisions.png, passage.png and loop.webm to CAPTURE_OUT.
const OUT_DIR = process.env.CAPTURE_OUT ?? '';
const SHOTS = { thread: 'thread.png', decisions: 'decisions.png', passage: 'passage.png', video: 'loop.webm' };
const NAME = 'plan';
const PAGE = `/${NAME}.html`;
const SOURCE = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'readme', `${NAME}.md`);
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const SITE = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const SIZE = { width: 1280, height: 800 };
const OWNER = 'hermes';
// The page names the reader by their address's part before the @.
const READER = 'maintainer';

const COMMENT = 'Can the first copy be checked by hand before the timer takes over?';
const REPLY = 'Yes: the rollout runs the job once by hand and restores that copy before the timer is turned on.';
const PASSAGE = 'opens the copy and reads it back';
const PASSAGE_COMMENT = 'Does reading it back catch a copy cut short by a full disk?';

function lotuspod(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  return JSON.parse(lotuspod('comments', action, ...args, '--json', '--socket', SOCKET, '--credential', HERMES));
}

// Publish the sample page as hermes, from a copy named for the page.
function publish() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-readme-'));
  try {
    const file = path.join(work, `${NAME}.md`);
    fs.copyFileSync(SOURCE, file);
    lotuspod('publish', file, '--local', '--date', '2026-09-30', '--out-dir', SITE,
      '--owner', OWNER, '--credential', HERMES);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    group: (title: string) => aside.locator('.artifact-comments-group')
      .filter({ has: page.locator('.artifact-comments-group-title', { hasText: title }) }),
  };
}

function entry(page: Page, id: number) {
  const item = page.locator(`.artifact-comments-entry[data-thread="${id}"]`);
  return {
    head: item.locator('.artifact-comments-entry-head'),
    readers: item.locator('.artifact-comment-item--reader'),
    agents: item.locator('.artifact-comment-item--agent'),
    waiting: item.locator('.artifact-comment-typing--pending'),
    writing: item.locator('.artifact-comment-typing--claimed'),
  };
}

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    option: (name: string) => form.getByRole('radio', { name }),
    addNote: form.locator('details.artifact-decision-note > summary'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    change: form.getByRole('button', { name: 'change' }),
  };
}

// Show only the threads this run made, should the site hold older ones.
async function ownThreads(page: Page, ids: Set<number>) {
  await page.route((url) => url.pathname === '/api/comments', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (route.request().method() === 'GET' && Array.isArray(body.threads)) {
      body.threads = body.threads.filter((thread: any) => ids.has(thread.root.id));
    } else if (response.status() === 201 && body.parent === null) {
      ids.add(body.id);
    }
    await route.fulfill({ response, json: body });
  });
}

// Select words of the body's text with the mouse.
async function drag(page: Page, words: string) {
  const spots = await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector('.artifact-body')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(wanted);
      if (at < 0 || node.parentElement!.closest('details, form')) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const first = range.getBoundingClientRect();
      range.setStart(node, at + wanted.length - 1);
      range.setEnd(node, at + wanted.length);
      const last = range.getBoundingClientRect();
      return {
        from: { x: first.left + 1, y: first.top + first.height / 2 },
        to: { x: last.right - 1, y: last.top + last.height / 2 },
      };
    }
    return null;
  }, words);
  expect(spots, `the body holds ${words}`).not.toBeNull();
  await page.mouse.move(spots!.from.x, spots!.from.y);
  await page.mouse.down();
  await page.mouse.move(spots!.to.x, spots!.to.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe(words);
}

test('the README pictures: a section thread hermes answers, the decisions answered, a passage comment', async ({ browser }) => {
  test.setTimeout(180_000);
  for (const [name, value] of Object.entries({ OUT_DIR, ASSERTION, SOCKET, HERMES, SITE, PYTHON })) {
    expect(value, `the capture run names ${name}`).toBeTruthy();
  }
  publish();
  // hermes pulls first, so it is listening and the comment waits for it.
  hermes('pull', '--owner', OWNER);

  const videos = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-readme-video-'));
  const context = await browser.newContext({
    baseURL: ENV.LOTUSPOD_URL,
    extraHTTPHeaders: SIGNED_IN,
    viewport: SIZE,
    recordVideo: { dir: videos, size: SIZE },
  });
  const page = await context.newPage();
  const video = page.video()!;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ids = new Set<number>();
  await ownThreads(page, ids);
  const side = panel(page);

  try {
    await page.goto(PAGE);
    await expect(page.getByText(`Published by ${OWNER}`)).toBeVisible();
    await expect(page.locator('details.artifact-comment[data-section="rollout"]')).toHaveCount(1);
    await page.waitForTimeout(600);

    await test.step('1. the reader comments on Rollout, and hermes replies', async () => {
      const chip = page.locator('details.artifact-comment[data-section="rollout"] > summary');
      await chip.click();
      const group = side.group('Rollout');
      const field = group.locator('textarea[name="text"]');
      await expect(field).toBeFocused();
      await field.pressSequentially(COMMENT, { delay: 12 });
      await group.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect.poll(() => ids.size).toBe(1);
      const [id] = [...ids];
      const thread = entry(page, id);
      await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
      await expect(thread.readers.locator('.artifact-comment-text')).toHaveText(COMMENT);
      // The page reads again 3 seconds after posting: until then the thread
      // shows it waits for hermes, then that hermes is writing, then the reply.
      await expect(thread.waiting).toContainText(`Checking for a reply from ${OWNER}`);
      const claim = hermes('claim', String(id));
      expect(claim.handle).toBe(OWNER);
      await expect(thread.writing).toBeVisible({ timeout: 15_000 });
      // A claim token may start with '-': give it to its option in one word.
      hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `readme-${id}`, '--text', REPLY);
      await expect(thread.agents).toHaveCount(1, { timeout: 15_000 });
      await expect(thread.agents.locator('.artifact-comment-handle')).toHaveText(OWNER);
      await expect(thread.agents.locator('.artifact-comment-text')).toHaveText(REPLY);
      await expect(thread.readers.locator('.artifact-comment-author')).toHaveText(READER);
      await page.mouse.move(5, 5);
      await page.screenshot({ path: path.join(OUT_DIR, SHOTS.thread) });
      await page.waitForTimeout(1500);
    });

    await test.step('2. the reader answers both decisions', async () => {
      await side.fold.click();
      const disk = decision(page, 'decision-1');
      const copies = decision(page, 'decision-2');
      await page.getByRole('heading', { name: 'Decisions for the maintainer' }).evaluate(
        (node) => window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' }));
      await page.waitForTimeout(800);
      // A run before this one on the same site saved them: open them again.
      for (const question of [disk, copies]) {
        if (await question.change.isVisible()) await question.change.click();
      }
      await disk.option('Second internal disk').check();
      await disk.save.click();
      await expect(disk.saved).toContainText('Saved · Second internal disk');
      await copies.option('Fourteen').check();
      if (!(await copies.note.isVisible())) await copies.addNote.click();
      await copies.note.fill('Two weeks covers a long holiday.');
      await copies.save.click();
      await expect(copies.saved).toContainText('Saved · Fourteen');
      await page.mouse.move(5, 5);
      await page.screenshot({ path: path.join(OUT_DIR, SHOTS.decisions) });
      await page.waitForTimeout(1200);
    });

    await test.step('3. the reader comments on a passage of Approach', async () => {
      await page.getByRole('heading', { name: 'Approach' }).evaluate(
        (node) => window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' }));
      await page.waitForTimeout(800);
      await drag(page, PASSAGE);
      await page.locator('button.artifact-passage-pill').click();
      const composer = side.group('Approach').locator('.artifact-passage-composer');
      await composer.locator('textarea').fill(PASSAGE_COMMENT);
      await composer.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect.poll(() => ids.size).toBe(2);
      const id = [...ids][1];
      const thread = entry(page, id);
      await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
      await expect(thread.readers.locator('.artifact-comment-text')).toHaveText(PASSAGE_COMMENT);
      const marks = page.locator(`.artifact-body mark.artifact-passage[data-thread="${id}"]`);
      await expect(marks.first()).toBeVisible();
      await expect(page.locator('.artifact-body button.artifact-passage-number')).toHaveText(['1']);
      await page.mouse.move(5, 5);
      await page.screenshot({ path: path.join(OUT_DIR, SHOTS.passage) });
      await page.waitForTimeout(1500);
    });
  } finally {
    await context.close();
  }
  await video.saveAs(path.join(OUT_DIR, SHOTS.video));
  fs.rmSync(videos, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
