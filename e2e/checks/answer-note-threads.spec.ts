import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// A reader's note on a saved answer opens a thread on that decision. The
// check publishes a page of its own as hermes on the capture fixture's site
// with a real `lotuspod publish --comments`, asking decision-1 (Sonnet / Opus)
// and decision-2 (Yes / No). Saving an answer with a note shows the
// decision's chip at once, the thread names the answer above the note, and
// hermes replies with real `lotuspod comments` commands on the fixture's
// agent socket.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const NAME = 'answer-note-threads-check';
const NOTE = 'Why not Sonnet for nightly runs?';
const REPLY = 'Sonnet is slower at night.';
const MARKDOWN = ['# Model choice', '', 'Which model runs at night.', '',
  '## Decisions for the maintainer', '',
  '| # | Question | Options |', '| --- | --- | --- |',
  '| 1 | Which model? | Sonnet / Opus |',
  '| 2 | Run it nightly? | Yes / No |', ''].join('\n');

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
  return JSON.parse(run('comments', action, ...args, '--json', '--socket', SOCKET, '--credential', HERMES));
}

function publish() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-note-threads-'));
  try {
    const file = path.join(dir, `${NAME}.md`);
    fs.writeFileSync(file, MARKDOWN, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', 'hermes',
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${NAME} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
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
    // The chip is the form's next sibling, outside it.
    chip: page.locator(`form.artifact-decision[data-question="${question}"] + button.artifact-decision-chip`),
  };
}

function thread(page: Page, id: number) {
  const item = page.locator(`aside.artifact-comments-panel .artifact-comments-entry[data-thread="${id}"]`);
  return {
    item,
    readers: item.locator('.artifact-comment-item--reader'),
    agents: item.locator('.artifact-comment-item--agent'),
  };
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  test("a note saved with an answer opens a thread under the decision, and hermes's reply shows there", async ({ page }) => {
    test.setTimeout(120_000);
    // The site keeps every answer and thread, so this runs once per site.
    test.skip(test.info().repeatEachIndex > 0, 'answers a page the first repeat answered');
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    publish();
    // hermes is listening, so the note waits for it.
    hermes('pull', '--owner', 'hermes');

    const errors = watch(page);
    await page.goto(`/${NAME}.html`);
    const model = decision(page, 'decision-1');
    await expect(model.chip).toHaveCount(0);
    await model.option('Opus').check();
    await model.addNote.click();
    await model.note.fill(NOTE);
    const answered = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/answers' && response.request().method() === 'POST');
    await model.save.click();
    const body = await (await answered).json();
    expect(body.comment.answer).toEqual({ id: body.id, choice: 'opus', label: 'Opus' });
    const id: number = body.comment.id;

    await expect(model.saved).toContainText('Saved · Opus');
    // No reload: the chip follows the form once the threads are read again.
    await expect(model.chip).toHaveText('1 comment · waiting');
    await model.chip.click();
    const mine = thread(page, id);
    await expect(mine.readers).toHaveCount(1);
    const first = mine.readers.first();
    await expect(first.locator('.artifact-comment-answered')).toHaveText('Answered: Opus');
    await expect(first.locator('.artifact-comment-text')).toHaveText(NOTE);
    const order = await first.evaluate((node) => {
      const line = node.querySelector('.artifact-comment-answered')!;
      const text = node.querySelector('.artifact-comment-text')!;
      return Boolean(line.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        line.getBoundingClientRect().bottom <= text.getBoundingClientRect().top + 1;
    });
    expect(order).toBe(true);
    expect(errors).toEqual([]);

    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe('hermes');
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `note-${id}`, '--text', REPLY);

    await page.reload();
    await expect(model.chip).toContainText('hermes answered');
    await model.chip.click();
    await expect(mine.agents).toHaveCount(1);
    await expect(mine.agents.locator('.artifact-comment-text')).toHaveText(REPLY);

    const nightly = decision(page, 'decision-2');
    await nightly.option('Yes').check();
    await nightly.save.click();
    await expect(nightly.saved).toContainText('Saved · Yes');
    await page.waitForTimeout(500);
    await expect(nightly.chip).toHaveCount(0);
    await expect(page.locator('form.artifact-decision[data-question="decision-2"] + .artifact-decision-chip'))
      .toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
