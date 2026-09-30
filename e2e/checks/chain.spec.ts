import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The whole chain as the maintainer uses it: the signed-in reader answers a
// decision and comments on the capture fixture's owned page in Chromium, and
// the page's owner, hermes, reads both, claims the comment, revises the page
// and replies through real `lotuspod` commands on the fixture's agent socket.
// Another agent's credential reaches none of it, and a reader without the
// Access assertion can store nothing.
const NAME = 'capture-owned';
const PAGE = `/${NAME}.html`;
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SIGNED_OUT = 'You are signed out. Reload the page to sign in.';
const READER = 'maintainer@example.com';
const OWNER = 'hermes';
const OTHER = 'claude-3f9a2c';
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OTHER_CREDENTIAL = ENV.LOTUSPOD_TEST_CREDENTIAL_OTHER ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');

const COMMENT = 'Which heater fits beside the pump?';
const NOTE = 'Submerged keeps the outlet free.';
const REVISED = 'Fit a submerged heater before the first frost, clear of the pump outlet.';
const REPLY = 'A submerged heater: the page now says where it goes.';

// One `lotuspod` command: its exit status and output.
function lotuspod(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
      encoding: 'utf-8',
      env: { ...ENV, PYTHONPATH: SRC },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    if (typeof failed.status !== 'number') throw error;
    return { status: failed.status, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

// `lotuspod comments ACTION ... --json` as the agent the credential is.
function agent(credential: string, action: string, ...args: string[]) {
  const done = lotuspod('comments', action, ...args, '--json',
    '--socket', SOCKET, '--credential', credential);
  expect(done.stdout, `lotuspod comments ${action} prints JSON: ${done.stderr}`).not.toBe('');
  return { status: done.status, json: JSON.parse(done.stdout), stderr: done.stderr };
}

function pull(credential: string, owner: string) {
  return agent(credential, 'pull', '--owner', owner);
}

function decision(page: Page) {
  const form = page.locator(`form.artifact-decision[data-question="decision-1"]`);
  return {
    option: (name: string | RegExp) => form.getByRole('radio', { name }),
    note: form.locator('textarea[name="note"]'),
    answer: form.getByRole('button', { name: 'Answer' }),
    status: form.locator('.artifact-decision-status'),
  };
}

function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  return {
    summary: details.locator('summary'),
    text: details.locator('form.artifact-comment-form textarea[name="text"]'),
    comment: details.getByRole('button', { name: 'Comment', exact: true }),
    status: details.locator('form.artifact-comment-form .artifact-comment-status'),
    threads: details.locator('.artifact-comment-thread'),
  };
}

// What the site keeps for the page: its answers and its threads.
async function stored(request: APIRequestContext) {
  const answers = await request.get(`/api/answers?page=${NAME}`, { headers: SIGNED_IN });
  const threads = await request.get(`/api/comments?page=${NAME}`, { headers: SIGNED_IN });
  expect(answers.status()).toBe(200);
  expect(threads.status()).toBe(200);
  return { answers: (await answers.json()).questions, threads: (await threads.json()).threads };
}

test.describe('the chain', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a signed-in answer and comment reach the owner alone, and its reply and revision reach the reader', async ({ page, browser, request }) => {
    test.setTimeout(180_000);
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OTHER_CREDENTIAL, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await test.step('1. hermes pulls, and is listening', () => {
      const first = pull(HERMES, OWNER);
      expect(first.status, first.stderr).toBe(0);
      expect(first.json.owner).toBe(OWNER);
      expect(first.json.items.filter((item: any) => item.page.name === NAME)).toEqual([]);
    });

    await test.step('2. the reader answers the decision and comments on the second section', async () => {
      await page.goto(PAGE);
      await expect(page.getByText(`Published by ${OWNER}`)).toBeVisible();
      const question = decision(page);
      await question.option('Submerged').check();
      await question.note.fill(NOTE);
      await question.answer.click();
      await expect(question.status).toContainText(`Answered by ${READER}`);

      const heater = box(page, 'heater');
      await heater.summary.click();
      await heater.text.fill(COMMENT);
      await heater.comment.click();
      await expect(heater.threads).toHaveCount(1);
      const thread = heater.threads.first();
      await expect(thread.locator('.artifact-comment-author')).toHaveText(READER);
      await expect(thread.locator('.artifact-comment-text')).toHaveText(COMMENT);
      await expect(thread.locator('.artifact-comment-state')).toHaveText(`waiting for ${OWNER}`);
    });

    let commentId = 0;
    await test.step(`3. ${OTHER} is refused hermes's queue and gets nothing of its own`, () => {
      const theirs = pull(OTHER_CREDENTIAL, OWNER);
      expect(theirs.status).toBe(1);
      expect(theirs.json).toEqual({ error: 'handle_not_allowed' });
      const own = pull(OTHER_CREDENTIAL, OTHER);
      expect(own.status, own.stderr).toBe(0);
      expect(own.json.items).toEqual([]);
      const threads = agent(OTHER_CREDENTIAL, 'show', NAME);
      expect(threads.status, threads.stderr).toBe(0);
      commentId = threads.json.threads[0].root.id;
      const claim = agent(OTHER_CREDENTIAL, 'claim', String(commentId));
      expect(claim.status).toBe(1);
      expect(claim.json).toEqual({ error: 'not_routed' });
    });

    let revision = '';
    await test.step('4. hermes pulls both with the source and revision, claims, revises the page and replies', () => {
      const pulled = pull(HERMES, OWNER);
      expect(pulled.status, pulled.stderr).toBe(0);
      const items = pulled.json.items.filter((item: any) => item.page.name === NAME);
      expect(items.map((item: any) => item.kind).sort()).toEqual(['answer', 'comment']);
      const source = fs.readFileSync(path.join(OUT, `${NAME}.md`), 'utf-8');
      const before = items[0].page.revision;
      expect(before).toMatch(/^[0-9a-f]{12}$/);
      for (const item of items) {
        expect(item.page).toMatchObject({ name: NAME, owner: OWNER, revision: before,
          sourceFile: `${NAME}.md`, source });
      }
      const comment = items.find((item: any) => item.kind === 'comment').comment;
      expect(comment).toMatchObject({ id: commentId, section: 'heater', text: COMMENT,
        owner: OWNER, state: 'pending', actor: { kind: 'human', email: READER } });
      const answer = items.find((item: any) => item.kind === 'answer');
      expect(answer.answer).toMatchObject({ question: 'decision-1', choice: 'submerged', note: NOTE,
        actor: { kind: 'human', email: READER } });
      expect(answer.question).toMatchObject({ text: 'Which heater?', label: 'Submerged' });

      const claim = agent(HERMES, 'claim', String(commentId));
      expect(claim.status, claim.stderr).toBe(0);
      expect(claim.json.handle).toBe(OWNER);

      const edited = source.replace('Fit a heater before the first frost.', REVISED);
      expect(edited).not.toBe(source);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-chain-'));
      try {
        const file = path.join(work, `${NAME}.md`);
        fs.writeFileSync(file, edited, 'utf-8');
        const published = lotuspod('publish', file, '--local', '--out-dir', OUT,
          '--expect-revision', before, '--owner', OWNER, '--credential', HERMES);
        expect(published.status, published.stderr).toBe(0);
        revision = /at revision ([0-9a-f]{12})/.exec(published.stdout)?.[1] ?? '';
        expect(revision).toMatch(/^[0-9a-f]{12}$/);
        expect(revision).not.toBe(before);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }

      // A claim token may start with '-': give it to its option in one word.
      const reply = agent(HERMES, 'reply', String(commentId), `--claim=${claim.json.claimToken}`,
        '--key', `chain-${commentId}`, '--text', REPLY, '--revision', revision);
      expect(reply.status, reply.stderr).toBe(0);
      expect(reply.json.parent).toBe(commentId);
    });

    await test.step('5. after a reload the reader sees the reply, its revision link, the edit and the answer', async () => {
      await page.reload();
      const heater = box(page, 'heater');
      await expect(heater.summary).toHaveText('Comments (1)');
      await heater.summary.click();
      const items = heater.threads.first().locator('.artifact-comment-item');
      await expect(items).toHaveCount(2);
      await expect(items.nth(0).locator('.artifact-comment-state')).toHaveText('answered');
      const reply = items.nth(1);
      await expect(reply.locator('.artifact-comment-agent')).toHaveText(OWNER);
      await expect(reply.locator('.artifact-comment-text')).toHaveText(REPLY);
      const link = reply.getByRole('link', { name: /^Revised the page/ });
      await expect(link).toHaveText(`Revised the page · revision ${revision}`);
      await expect(link).toHaveAttribute('href', `${NAME}.html`);

      await link.click();
      await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
      await expect(page.getByText(REVISED)).toBeVisible();
      await expect(page.getByText(`Published by ${OWNER}`)).toBeVisible();
      const question = decision(page);
      await expect(question.option('Submerged')).toBeChecked();
      await expect(question.note).toHaveValue(NOTE);
      await expect(question.status).toContainText(`Answered by ${READER}`);
    });

    await test.step('6. without the assertion, answering and commenting are refused and nothing is stored', async () => {
      const before = await stored(request);
      // A context made in a test takes the project's options: clear the header.
      const context = await browser.newContext({ baseURL: ENV.LOTUSPOD_URL, extraHTTPHeaders: {} });
      try {
        expect((await context.request.get('/api/whoami')).status()).toBe(401);
        const outside = await context.newPage();
        await outside.goto(PAGE);
        const question = decision(outside);
        await question.option(/^Floating/).check();
        await question.note.fill('Not signed in');
        await question.answer.click();
        await expect(question.status).toHaveText(SIGNED_OUT);

        const pump = box(outside, 'pump');
        await pump.summary.click();
        await pump.text.fill('Not signed in either.');
        await pump.comment.click();
        await expect(pump.status).toHaveText(SIGNED_OUT);
        await expect(pump.threads).toHaveCount(0);
      } finally {
        await context.close();
      }
      expect(await stored(request)).toEqual(before);
    });

    await test.step("the audit lists hermes's claim and reply under its credential", () => {
      const audit = lotuspod('audit', '--json', '--page', NAME, '--out-dir', OUT);
      expect(audit.status, audit.stderr).toBe(0);
      const rows = JSON.parse(audit.stdout).filter((row: any) => row.comment === commentId);
      expect(rows.map((row: any) => [row.action, row.credential, row.handle])).toEqual([
        ['claim', OWNER, OWNER],
        ['reply', OWNER, OWNER],
      ]);
      expect(rows[1].key).toBe(`chain-${commentId}`);
    });

    expect(errors).toEqual([]);
  });
});
