import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Questions about a decision: the capture fixture's decision threads page,
// two sections, the second asking two questions. On a page that takes
// comments each decision has an Ask beside "Save answer", which posts its
// note as a thread on the decision, and a chip under it once it has threads,
// which opens them in the panel, a popover or the bottom sheet. The run
// shares one database, so each check shows only the threads it made, found
// by id. hermes pulls, claims, replies and publishes the page again through
// real `lotuspod` commands on the fixture's agent socket.
const PAGE = '/capture-decision-threads.html';
const SLUG = 'capture-decision-threads';
// The fixture's decisions page asks two questions and takes no comments.
const NO_COMMENTS = '/capture-decisions.html';
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
const QUESTION = 'Which heater?';
const WIDE = { width: 1280, height: 800 };
const MEDIUM = { width: 900, height: 800 };
const PHONE = { width: 390, height: 844 };
const NO_QUESTION = 'Write your question in the note, then press Ask.';
const STALE = 'This page has changed since it loaded. Reload it to ask about this decision.';
const SIGNED_OUT = 'You are signed out. Reload the page to sign in.';

test.use({ viewport: WIDE });

type Violation = { blockedURI: string; effectiveDirective: string };

// Errors, policy violations and how many reads are in flight. A status a
// check is answered with is logged by the browser itself, as the network's
// line; only that line is not an error.
async function watch(page: Page, answered: string[] = []) {
  const errors: string[] = [];
  page.on('console', (message) => {
    const expected = answered.some((status) =>
      message.text() === `Failed to load resource: the server responded with a status of ${status}`);
    if (message.type() === 'error' && !expected) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    const seen: Violation[] = [];
    w.__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
    w.__inflight = 0;
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      w.__inflight++;
      try {
        return await real(input, init);
      } finally {
        w.__inflight--;
      }
    };
  });
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

function run(args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  return JSON.parse(run(['comments', action, ...args, '--json', '--socket', SOCKET, '--credential', HERMES]));
}

// hermes pulls, so it is listening and a new comment waits for it.
function listen() {
  return hermes('pull', '--owner', OWNER);
}

// Show only the threads whose ids are in ids, and add each thread the page
// posts to them.
async function ownThreads(page: Page, ids: Set<number>) {
  await page.route((url) => url.pathname === '/api/comments', async (route) => {
    const request = route.request();
    const response = await route.fetch();
    const body = await response.json();
    if (request.method() === 'GET' && Array.isArray(body.threads)) {
      body.threads = body.threads.filter((thread: any) => ids.has(thread.root.id));
    } else if (response.status() === 201 && body.parent === null) {
      ids.add(body.id);
    }
    await route.fulfill({ response, json: body });
  });
}

// Answer the page's read of the answers as unanswered: a check that saves
// an answer leaves it in the run's database.
async function unanswered(page: Page) {
  await page.route((url) => url.pathname === '/api/answers', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { page: SLUG, questions: {} } })
      : route.fallback());
}

// Every request the page sends to the API after this, as method and path.
function record(page: Page) {
  const sent: { method: string; path: string; body: any }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      sent.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    }
  });
  return sent;
}

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

async function load(page: Page) {
  await page.goto(PAGE);
  await expect(page.locator('details.artifact-comment')).toHaveCount(2);
  await settle(page);
}

function revisionOf(page: Page) {
  return page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
}

// A thread on a section or a decision, posted to the site.
async function post(request: APIRequestContext, fields: Record<string, unknown>) {
  const response = await request.post('/api/comments', { headers: SIGNED_IN, data: { page: SLUG, ...fields } });
  expect(response.status()).toBe(201);
  return response.json();
}

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    option: (name: string) => form.getByRole('radio', { name }),
    addNote: form.locator('details.artifact-decision-note > summary'),
    noteBox: form.locator('details.artifact-decision-note'),
    note: form.locator('textarea[name="note"]'),
    save: form.getByRole('button', { name: 'Save answer' }),
    ask: form.getByRole('button', { name: 'Ask', exact: true }),
    hint: form.locator('.artifact-decision-hint'),
    status: form.locator('.artifact-decision-status'),
    saved: form.locator('.artifact-decision-saved-line'),
    // The chip is the form's next sibling, outside it.
    chip: page.locator(`form.artifact-decision[data-question="${question}"] + .artifact-decision-chip`),
  };
}

// Write words in a decision's note and press Ask.
async function ask(page: Page, question: string, words: string) {
  const card = decision(page, question);
  await card.addNote.click();
  await card.note.fill(words);
  await card.ask.click();
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    aside,
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    dots: aside.locator('.artifact-comments-dot'),
    showResolved: aside.locator('.artifact-comments-show-resolved'),
    group: (title: string) => aside.locator('.artifact-comments-group')
      .filter({ has: page.locator('.artifact-comments-group-title', { hasText: title }) }),
  };
}

function entry(page: Page, id: number) {
  const item = page.locator(`.artifact-comments-entry[data-thread="${id}"]`);
  return {
    item,
    head: item.locator('.artifact-comments-entry-head'),
    words: item.locator('.artifact-comments-entry-head .artifact-comments-entry-words'),
    resolve: item.getByRole('button', { name: 'Resolve' }),
    reopen: item.getByRole('button', { name: 'Reopen' }),
    readers: item.locator('.artifact-comment-item--reader'),
    agents: item.locator('.artifact-comment-item--agent'),
    waiting: item.locator('.artifact-comment-typing--pending .artifact-comment-bubble'),
  };
}

function held(page: Page, kind: 'popover' | 'bottom-sheet') {
  const node = page.locator(`.artifact-comments-${kind}`);
  return {
    node,
    title: node.locator('.artifact-comments-held-title'),
    at: node.locator('.artifact-comments-bottom-sheet-at'),
    thread: (id: number) => node.locator(`.artifact-comment-thread[data-thread="${id}"]`),
  };
}

function bounds(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left };
  });
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeAll(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('Ask posts the note as a question on the decision, saves no answer and opens the thread in the panel', async ({ page, request }) => {
    const seen = await watch(page);
    listen();
    const ids = new Set<number>();
    // A thread on the decision's section, older than the question.
    const own = await post(request, { section: 'winter', text: 'Is the heater on its own fuse?' });
    ids.add(own.id);
    await ownThreads(page, ids);
    await unanswered(page);
    await load(page);
    const revision = await revisionOf(page);
    expect(revision).toBeTruthy();
    const first = decision(page, 'decision-1');
    await expect(first.ask).toBeVisible();
    await expect(first.ask).toHaveAttribute('type', 'button');
    // Ask sits beside "Save answer", in the form's foot.
    expect(await first.save.evaluate((node) => node.nextElementSibling?.textContent)).toBe('Ask');
    await expect(first.chip).toHaveCount(0);

    const sent = record(page);
    const words = 'Does the floating one survive a hard frost?';
    await ask(page, 'decision-1', words);
    await expect.poll(() => ids.size).toBe(2);
    const id = [...ids].find((each) => each !== own.id)!;
    await settle(page);
    const posts = sent.filter((each) => each.method === 'POST');
    expect(posts).toEqual([{
      method: 'POST', path: '/api/comments',
      body: { page: SLUG, question: 'decision-1', text: words, revision },
    }]);
    expect(sent.filter((each) => each.path === '/api/answers')).toEqual([]);

    await expect(first.note).toHaveValue('');
    await expect(first.noteBox).not.toHaveAttribute('open');
    await expect(first.hint).toHaveText('Not answered yet');
    await expect(first.hint).toBeVisible();
    await expect(first.status).toHaveText('');

    const side = panel(page);
    await expect(side.fold).toBeVisible();
    const mine = entry(page, id);
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.head).toBeFocused();
    await expect(mine.words).toHaveText(`Decision 1 · ${QUESTION}`);
    await expect(mine.readers.locator('.artifact-comment-text')).toHaveText(words);
    await expect(mine.waiting).toHaveText(`Checking for a reply from ${OWNER}`);
    // Listed under its section's heading, before the section's § threads.
    const listed = side.group('Winter').locator('.artifact-comments-entry');
    await expect(listed).toHaveCount(2);
    expect(await listed.evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset.thread))))
      .toEqual([id, own.id]);
    await expect(entry(page, own.id).item.locator('.artifact-comments-entry-head .artifact-comments-entry-mark'))
      .toHaveText('§');

    // The chip under the decision; the section's chip counts both threads.
    await expect(first.chip).toHaveText('1 comment · waiting');
    await expect(page.locator('details.artifact-comment[data-section="winter"] > summary'))
      .toHaveText('2 comments · waiting');
    await expect(decision(page, 'decision-2').chip).toHaveCount(0);
    await seen.clean();
  });

  test('Ask with an empty note, or one of only spaces, sends nothing and says to write the question', async ({ page }) => {
    const seen = await watch(page);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await unanswered(page);
    await load(page);
    const second = decision(page, 'decision-2');
    const sent = record(page);
    await second.ask.click();
    await expect(second.status).toHaveText(NO_QUESTION);
    await expect(second.noteBox).not.toHaveAttribute('open');
    await second.form.evaluate((form) => {
      form.querySelector('.artifact-decision-status')!.textContent = '';
    });
    await second.addNote.click();
    await second.note.fill('   ');
    await second.ask.click();
    await expect(second.status).toHaveText(NO_QUESTION);
    await expect(second.note).toHaveValue('   ');
    await page.waitForTimeout(300);
    expect(sent).toEqual([]);
    expect(ids.size).toBe(0);
    await expect(second.chip).toHaveCount(0);
    await seen.clean();
  });

  test("hermes pulls the question with its decision and replies in the open thread, a reply waits again, and an answer leaves the chip", async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await watch(page);
    listen();
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page);
    const first = decision(page, 'decision-1');
    await ask(page, 'decision-1', 'Does the floating one need a stand?');
    await expect.poll(() => ids.size).toBe(1);
    const [id] = [...ids];
    const mine = entry(page, id);
    await expect(mine.waiting).toHaveText(`Checking for a reply from ${OWNER}`);

    const pulled = listen();
    const item = pulled.items.find((each: any) => each.kind === 'comment' && each.comment.id === id);
    expect(item.comment.question).toBe('decision-1');
    expect(item.decision).toMatchObject({ id: 'decision-1', text: QUESTION, answer: null, asked: true });

    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe(OWNER);
    await expect(first.chip).toHaveText(`${OWNER} is writing…`, { timeout: 15_000 });
    const REPLY = 'It does not: it floats on its own collar.';
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `decision-${id}`, '--text', REPLY);
    await expect(mine.agents).toHaveCount(1, { timeout: 15_000 });
    await expect(mine.agents.locator('.artifact-comment-text')).toHaveText(REPLY);
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    // The reply is the reader's to read: counted until the thread next opens.
    await expect(first.chip).toHaveText(`1 reply · ✓ ${OWNER} answered · 1 new`);
    await expect(first.hint).toHaveText('Not answered yet');

    // The reader replies from the thread's composer: it waits for hermes again.
    await mine.item.getByRole('button', { name: 'Reply', exact: true }).click();
    await mine.item.locator('form.artifact-comment-reply textarea[name="text"]').fill('And in a gale?');
    await mine.item.getByRole('button', { name: 'Send' }).click();
    await expect(mine.readers).toHaveCount(2);
    await expect(mine.waiting).toHaveText(`Checking for a reply from ${OWNER}`);
    await expect(first.chip).toHaveText('3 comments · waiting');

    // An answer saved folds the card, and the chip stays under it.
    await first.option('Floating').check();
    await first.save.click();
    await expect(first.saved).toContainText('Saved');
    await expect(first.chip).toBeVisible();
    const card = await bounds(page, 'form.artifact-decision[data-question="decision-1"]');
    const chip = await bounds(page, 'form.artifact-decision[data-question="decision-1"] + .artifact-decision-chip');
    expect(chip.top).toBeGreaterThanOrEqual(card.bottom - 1);
    await expect(first.ask).toBeHidden();
    // "change" opens the card again, Ask with it.
    await first.form.getByRole('button', { name: 'change' }).click();
    await expect(first.ask).toBeVisible();
    await expect(decision(page, 'decision-2').chip).toHaveCount(0);
    await expect(page.locator('.artifact-decision-chip')).toHaveCount(1);
    await seen.clean();
  });

  test("a decision's chip opens its thread in the panel by click, Enter and Space, and shows it resolved and reopened", async ({ page, request }) => {
    const seen = await watch(page);
    listen();
    const asked = await post(request, { question: 'decision-1', text: 'Which outlet does it share?' });
    await ownThreads(page, new Set([asked.id]));
    await unanswered(page);
    await load(page);
    const first = decision(page, 'decision-1');
    const side = panel(page);
    const mine = entry(page, asked.id);
    await expect(first.chip).toHaveText('1 comment · waiting');
    await expect(side.fold).toBeHidden();
    await expect(side.dots).toHaveCount(1);

    await first.chip.click();
    await expect(side.fold).toBeVisible();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.head).toBeFocused();
    for (const key of ['Enter', 'Space']) {
      // Its entry folded and the panel folded first.
      await mine.head.click();
      await expect(mine.head).toHaveAttribute('aria-expanded', 'false');
      await side.fold.click();
      await expect(side.fold).toBeHidden();
      await first.chip.focus();
      await page.keyboard.press(key);
      await expect(side.fold).toBeVisible();
      await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
      await expect(mine.head).toBeFocused();
    }

    await mine.resolve.click();
    await expect(first.chip).toHaveText('1 resolved');
    await expect(side.dots).toHaveCount(0);
    await expect(mine.head).toBeHidden();
    // All its threads resolved, the chip shows them, Reopen at hand.
    await first.chip.click();
    await expect(mine.reopen).toBeFocused();
    await mine.reopen.click();
    await expect(first.chip).toHaveText('1 comment · waiting');
    await expect(side.dots).toHaveCount(1);
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await seen.clean();
  });

  test("with every thread resolved, a decision's chip opens the one with the newest reader comment", async ({ page, request }) => {
    const seen = await watch(page);
    const older = await post(request, { question: 'decision-1', text: 'Does it need its own outlet?' });
    const newer = await post(request, { question: 'decision-1', text: 'How loud is the pump?' });
    // The older thread's reader writes in it last.
    await post(request, { parent: older.id, text: 'And may it share the pump\'s?' });
    for (const thread of [older, newer]) {
      const response = await request.post('/api/comments', {
        headers: SIGNED_IN, data: { page: SLUG, thread: thread.id, resolved: true },
      });
      expect(response.status()).toBe(200);
    }
    await ownThreads(page, new Set([older.id, newer.id]));
    await unanswered(page);
    await load(page);
    const first = decision(page, 'decision-1');
    await expect(first.chip).toHaveText('2 resolved');
    await first.chip.click();
    await expect(entry(page, older.id).reopen).toBeFocused();
    await seen.clean();
  });

  test('a note changed while its question is sending is kept, unsent and unsaved', async ({ page }) => {
    const seen = await watch(page);
    listen();
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await unanswered(page);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let arrived = () => {};
    const sending = new Promise<void>((resolve) => { arrived = resolve; });
    // The question's POST waits until the note has changed.
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() === 'POST') {
        arrived();
        await gate;
      }
      await route.fallback();
    });
    await load(page);
    const first = decision(page, 'decision-1');
    await ask(page, 'decision-1', 'Can it freeze?');
    await sending;
    await first.note.fill('Does it need a fuse?');
    release();
    await expect.poll(() => ids.size).toBe(1);
    await expect(first.chip).toHaveText('1 comment · waiting');
    await expect(first.note).toHaveValue('Does it need a fuse?');
    await expect(first.noteBox).toHaveAttribute('open');
    await expect(first.form).toHaveClass(/artifact-decision--dirty/);
    await expect(first.hint).toBeHidden();
    await seen.clean();
  });

  test('at 900 pixels a question opens in a popover under the chip, and at 390 in the bottom sheet among the open threads', async ({ page, request }) => {
    const seen = await watch(page);
    listen();
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await unanswered(page);
    await page.setViewportSize(MEDIUM);
    await load(page);
    await ask(page, 'decision-1', 'Is the submerged one quieter?');
    await expect.poll(() => ids.size).toBe(1);
    const [first] = [...ids];
    const pop = held(page, 'popover');
    await expect(pop.node).toBeVisible();
    await expect(pop.title).toHaveText(`Decision 1: ${QUESTION}`);
    await expect(pop.node).toHaveAttribute('aria-label', `Decision 1: ${QUESTION}`);
    await expect(pop.thread(first)).toBeVisible();
    await expect(page.locator('aside.artifact-comments-panel')).toBeHidden();
    const chip = await bounds(page, 'form.artifact-decision[data-question="decision-1"] + .artifact-decision-chip');
    const box = await bounds(page, '.artifact-comments-popover');
    expect(box.top).toBeGreaterThan(chip.bottom);
    expect(box.top - chip.bottom).toBeLessThan(40);

    // On a phone, after a thread on the first section.
    const own = await post(request, { section: 'pond', text: 'Does the pond need both?' });
    ids.add(own.id);
    await page.setViewportSize(PHONE);
    await load(page);
    await ask(page, 'decision-1', 'Which one is cheaper to run?');
    await expect.poll(() => ids.size).toBe(3);
    const sheet = held(page, 'bottom-sheet');
    await expect(sheet.node).toBeVisible();
    await expect(sheet.title).toHaveText(`Decision 1: ${QUESTION}`);
    await expect(sheet.node).toHaveAttribute('aria-label', `Decision 1: ${QUESTION}`);
    await expect(sheet.at).toHaveText('3 of 3');
    const last = Math.max(...ids);
    await expect(sheet.thread(last)).toBeVisible();
    await seen.clean();
  });

  test('a page with decisions and no comment boxes has no Ask and no chip', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(NO_COMMENTS);
    await settle(page);
    await expect(page.locator('form.artifact-decision')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Save answer' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
    await expect(page.locator('.artifact-decision-ask, .artifact-decision-chip')).toHaveCount(0);
    await seen.clean();
  });

  test('a page published again since it loaded keeps the question and says to reload', async ({ page }) => {
    test.setTimeout(120_000);
    const seen = await watch(page, ['409 (Conflict)']);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await unanswered(page);
    await load(page);
    const before = (await revisionOf(page))!;
    const source = fs.readFileSync(path.join(path.dirname(OUT), `${SLUG}.md`), 'utf-8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-decision-threads-'));
    try {
      const file = path.join(dir, `${SLUG}.md`);
      fs.writeFileSync(file, source.replace('the pump stops with it.', 'the pump stops with it, every year.'), 'utf-8');
      run(['publish', file, '--local', '--out-dir', OUT, '--comments', '--owner', OWNER,
        '--credential', HERMES, '--expect-revision', before]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const words = 'Will the heater be enough?';
    await ask(page, 'decision-1', words);
    const first = decision(page, 'decision-1');
    await expect(first.status).toHaveText(STALE);
    await expect(first.note).toHaveValue(words);
    expect(ids.size).toBe(0);
    await expect(first.chip).toHaveCount(0);
    await seen.clean();
  });
});

test.describe('signed out', () => {
  test('Ask is refused with the line the answers use, and the note is kept', async ({ page }) => {
    const seen = await watch(page, ['401 (Unauthorized)']);
    await page.goto(PAGE);
    await settle(page);
    await ask(page, 'decision-2', 'Do they need feeding at all?');
    const second = decision(page, 'decision-2');
    await expect(second.status).toHaveText(SIGNED_OUT);
    await expect(second.note).toHaveValue('Do they need feeding at all?');
    await seen.clean();
  });
});
