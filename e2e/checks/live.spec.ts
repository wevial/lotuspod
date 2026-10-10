import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// At this width a box never opens: its chip opens the section's threads in
// a popover over the text. panel.spec.ts checks the side panel a wider
// window gets, and narrow.spec.ts the popover and a phone's bottom sheet.
const MEDIUM = { width: 1024, height: 768 };
test.use({ viewport: MEDIUM });

// The comments page checks for replies while a thread on it waits. One check
// runs on the real clock against the capture fixture's site, with hermes
// claiming and replying through real `lotuspod` commands on the fixture's
// agent socket; the rest answer the threads route themselves and drive the
// page's clock, so the schedule needs no real waiting.
const PAGE = '/capture-comments.html';
const THREADS = (url: URL) => url.pathname === '/api/comments';
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SIGNED_OUT = 'You are signed out. Reload the page to sign in.';
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const OWNER = 'hermes';
const AGENT = { kind: 'agent', handle: OWNER };
const START = Date.parse('2026-09-30T12:00:00Z');

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  const stdout = execFileSync(PYTHON, [
    '-m', 'lotuspod', 'comments', action, ...args, '--json',
    '--socket', SOCKET, '--credential', HERMES,
  ], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

// A section's box: its chip, and the popover it opens, which holds the
// section's threads and its form for a new one.
function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  const popover = page.locator('.artifact-comments-popover');
  return {
    summary: details.locator('summary'),
    popover,
    start: popover.getByRole('button', { name: 'Comment on this section' }),
    text: popover.locator('form.artifact-comment-form textarea[name="text"]'),
    comment: popover.getByRole('button', { name: 'Comment', exact: true }),
    threads: popover.locator('.artifact-comment-thread'),
  };
}

function thread(page: Page, root: { id: number }) {
  const node = page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
  return {
    node,
    toggle: node.locator('.artifact-comment-toggle'),
    field: node.locator('form.artifact-comment-reply textarea[name="text"]'),
    send: node.getByRole('button', { name: 'Send' }),
    readers: node.locator('.artifact-comment-item--reader'),
    agents: node.locator('.artifact-comment-item--agent'),
  };
}

let next = 1;

function row(fields: Record<string, unknown>) {
  const id = next++;
  return {
    id,
    page: 'capture-comments',
    section: 'findings',
    sectionTitle: 'Findings',
    revision: '',
    parent: null,
    text: `Comment ${id}`,
    quote: null,
    actor: { kind: 'human', name: READER },
    createdAt: '2026-09-30T10:00:00.000Z',
    state: 'pending',
    ...fields,
  };
}

function reply(root: { id: number }, text: string) {
  return row({ parent: root.id, state: 'answered', text, actor: AGENT });
}

type Answer = { status?: number; threads?: unknown[] };

// Answer the threads route's reads in turn: the nth read (from 1) gets what
// answer(n) gives. Posts get post(body), else go to the site.
async function serve(page: Page, answer: (n: number) => Answer,
  post?: (body: any) => unknown) {
  let reads = 0;
  await page.route(THREADS, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      const { status = 200, threads = [] } = answer(++reads);
      await route.fulfill(status === 200
        ? { json: { page: 'capture-comments', threads } }
        : { status, json: { error: 'unauthenticated' } });
    } else if (post) {
      await route.fulfill({ status: 201, json: post(request.postDataJSON()) });
    } else {
      await route.continue();
    }
  });
}

// Note the page's time at each read of the threads route, and how many reads
// are in flight. Added after the clock, so the time is the page's own.
async function watchReads(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.__reads = [];
    w.__inflight = 0;
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== '/api/comments' || (init?.method ?? 'GET') !== 'GET') return real(input, init);
      w.__reads.push(Date.now());
      w.__inflight++;
      try {
        return await real(input, init);
      } finally {
        w.__inflight--;
      }
    };
  });
  return {
    errors,
    times: () => page.evaluate(() => (window as any).__reads as number[]),
  };
}

// The page's clock, paused at START: it moves only when moved.
async function stopClock(page: Page) {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
}

// Let the read in flight, if any, come back.
async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

// Move the page's clock on by ms, a second at a time, letting each read come
// back before time moves on.
async function pass(page: Page, ms: number) {
  await settle(page);
  for (let done = 0; done < ms; done += 1000) {
    await page.clock.runFor(Math.min(1000, ms - done));
    await settle(page);
  }
}

async function load(page: Page) {
  await page.goto(`${PAGE}?standalone`);
  await expect(page.locator('.artifact-body details.artifact-comment')).toHaveCount(3);
  await settle(page);
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test("hermes's claim and reply are drawn in place, announced, without a reload", async ({ page }) => {
    test.setTimeout(120_000);
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // hermes pulls first, so it is listening and the comment waits for it.
    hermes('pull', '--owner', OWNER);

    await page.goto(`${PAGE}?standalone`);
    const steps = box(page, 'next-steps');
    await steps.summary.click();
    await expect(steps.popover).toBeVisible();
    const before = await steps.threads.count();
    // With threads already in it, the section's form is folded behind a control.
    if (before) await steps.start.click();
    await expect(steps.text).toBeFocused();
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    const COMMENT = 'Which heater, and where does it go?';
    await steps.text.fill(COMMENT);
    await steps.comment.click();
    await expect(steps.threads).toHaveCount(before + 1);
    const node = steps.threads.last();
    const id = Number(await node.getAttribute('data-thread'));
    await expect(node).toBeVisible();
    const mine = thread(page, { id });
    await expect(node.locator('.artifact-comment-typing--pending .artifact-comment-bubble'))
      .toHaveText(`Checking for a reply from ${OWNER}`);
    await expect(mine.toggle).toHaveText('Add to your comment');

    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe(OWNER);
    await expect(node.locator('.artifact-comment-typing--claimed .artifact-comment-by'))
      .toHaveText(`${OWNER} AGENT is writing`, { timeout: 15_000 });

    const REPLY = 'A submerged heater, clear of the pump outlet.';
    // A claim token may start with '-': give it to its option in one word.
    const answered = hermes('reply', String(id), `--claim=${claim.claimToken}`,
      '--key', `live-${id}`, '--text', REPLY);
    expect(answered.parent).toBe(id);
    await expect(mine.agents).toHaveCount(1, { timeout: 15_000 });
    const theirs = mine.agents.first();
    await expect(theirs.locator('.artifact-comment-text')).toHaveText(REPLY);
    await expect(theirs.locator('.artifact-comment-handle')).toHaveText(OWNER);
    await expect(node.locator('.artifact-comment-typing')).toHaveCount(0);
    await expect(mine.toggle).toHaveText('Reply');
    // A left-hand bubble: left of the reader's.
    const left = (await theirs.locator('.artifact-comment-text').boundingBox())!;
    const right = (await mine.readers.first().locator('.artifact-comment-text').boundingBox())!;
    expect(left.x).toBeLessThan(right.x);

    // The reply is in the thread's polite live region; the comment is there once.
    await expect(theirs.locator('xpath=ancestor::*[@aria-live="polite"]')).toHaveCount(1);
    await expect(mine.readers).toHaveCount(1);
    await expect(page.locator('.artifact-comment-text', { hasText: COMMENT })).toHaveCount(1);
    await expect(theirs).toBeVisible();
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(errors).toEqual([]);
  });

  test("a reply naming its model shows it after the AGENT tag, on the handle's line", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    hermes('pull', '--owner', OWNER);
    const posted = await page.request.post('/api/comments', {
      data: { page: 'capture-comments', section: 'next-steps', text: 'Which model answers this?' },
    });
    expect(posted.status()).toBe(201);
    const { id } = await posted.json();

    await page.goto(`${PAGE}?standalone`);
    await box(page, 'next-steps').summary.click();
    const mine = thread(page, { id });
    await expect(mine.node).toBeVisible();
    const claim = hermes('claim', String(id));
    const MODEL = 'Claude Opus 5.5';
    const answered = hermes('reply', String(id), `--claim=${claim.claimToken}`,
      '--key', `model-${id}`, '--text', 'This one does.', '--model', MODEL);
    expect(answered.model).toBe(MODEL);
    await expect(mine.agents).toHaveCount(1, { timeout: 15_000 });
    const by = mine.agents.first().locator('.artifact-comment-by');
    await expect(by.locator('.artifact-comment-model')).toHaveText(MODEL);
    // The handle, the AGENT tag and the model, in that order, on one line.
    const parts = by.locator('.artifact-comment-handle, .artifact-comment-agent, .artifact-comment-model');
    expect(await parts.evaluateAll((nodes) => nodes.map((node) => node.className)))
      .toEqual(['artifact-comment-handle', 'artifact-comment-agent', 'artifact-comment-model']);
    const boxes = await parts.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    for (let n = 1; n < boxes.length; n++) {
      expect(boxes[n].left).toBeGreaterThanOrEqual(boxes[n - 1].right);
      expect(boxes[n].top).toBeLessThan(boxes[n - 1].bottom);
      expect(boxes[n].bottom).toBeGreaterThan(boxes[n - 1].top);
    }
    expect(errors).toEqual([]);
  });

  test('a reply naming no model shows no label, and a model is drawn as written', async ({ page }) => {
    const reads = await watchReads(page);
    const root = row({ state: 'answered' });
    const plain = reply(root, 'No model named.');
    const named = { ...reply(root, 'An entity in the name.'), model: 'a&amp;b' };
    await serve(page, () => ({ threads: [{ root, replies: [plain, named] }] }));
    await stopClock(page);
    await load(page);
    await box(page, 'findings').summary.click();
    const drawn = thread(page, root);
    await expect(drawn.agents).toHaveCount(2);
    await expect(drawn.agents.first().locator('.artifact-comment-model')).toHaveCount(0);
    await expect(drawn.agents.first().locator('.artifact-comment-by')).toHaveText(/^hermes AGENT /);
    await expect(drawn.agents.nth(1).locator('.artifact-comment-model')).toHaveText('a&amp;b');
    expect(reads.errors).toEqual([]);
  });

  test('reads back off from 3 seconds to 30 while a thread stays pending', async ({ page }) => {
    const reads = await watchReads(page);
    const pending = row({ state: 'pending' });
    await serve(page, () => ({ threads: [{ root: pending, replies: [] }] }));
    await stopClock(page);
    await load(page);
    await pass(page, 120_000);

    const times = await reads.times();
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    expect(gaps.length).toBeGreaterThan(3);
    expect(gaps[0]).toBeLessThanOrEqual(5000);
    gaps.slice(1).forEach((gap, index) => expect(gap).toBeGreaterThanOrEqual(gaps[index]));
    expect(gaps[gaps.length - 1]).toBe(30_000);
    expect(reads.errors).toEqual([]);
  });

  test('nothing is read again while no thread waits', async ({ page }) => {
    const reads = await watchReads(page);
    const threads = ['answered', 'unavailable', 'paused']
      .map((state) => ({ root: row({ state }), replies: [] }));
    await serve(page, () => ({ threads }));
    await stopClock(page);
    await load(page);
    await pass(page, 120_000);
    expect(await reads.times()).toHaveLength(1);
    expect(reads.errors).toEqual([]);
  });

  test('reads stop once the waiting thread is answered', async ({ page }) => {
    const reads = await watchReads(page);
    const root = row({ state: 'pending' });
    const answer = reply(root, 'Done.');
    await serve(page, (n) => ({
      threads: [n < 3 ? { root, replies: [] } : { root: { ...root, state: 'answered' }, replies: [answer] }],
    }));
    await stopClock(page);
    await load(page);
    await pass(page, 120_000);
    expect(await reads.times()).toHaveLength(3);
    await box(page, 'findings').summary.click();
    await expect(thread(page, root).agents).toHaveCount(1);
    await expect(thread(page, root).agents).toBeVisible();
    await expect(thread(page, root).node.locator('.artifact-comment-typing')).toHaveCount(0);
    expect(reads.errors).toEqual([]);
  });

  test("an agent's follow-up on an answered thread in view is drawn as its message at the next read", async ({ page }) => {
    const reads = await watchReads(page);
    const root = row({ state: 'answered' });
    const answer = reply(root, "I'm asking the author; I'll post their answer here.");
    const FOLLOW = 'The author says the heater is enough.';
    const followUp = reply(root, FOLLOW);
    // The only thread on the page, answered: nothing waits. The follow-up is
    // there from the second read on.
    await serve(page, (n) => ({ threads: [{ root, replies: n < 2 ? [answer] : [answer, followUp] }] }));
    await stopClock(page);
    await load(page);
    // Out of view, an answered thread is not read again.
    await pass(page, 60_000);
    expect(await reads.times()).toHaveLength(1);

    const findings = box(page, 'findings');
    await findings.summary.click();
    const answered = thread(page, root);
    await expect(answered.node).toBeVisible();
    await pass(page, 5000);
    expect((await reads.times()).length).toBeGreaterThanOrEqual(2);
    await expect(answered.agents).toHaveCount(2);
    const theirs = answered.agents.nth(1);
    await expect(theirs.locator('.artifact-comment-text')).toHaveText(FOLLOW);
    await expect(theirs.locator('.artifact-comment-handle')).toHaveText(OWNER);
    await expect(theirs).toBeVisible();
    // After the first reply, in the thread's polite live region, left of the reader's.
    const first = (await answered.agents.first().boundingBox())!;
    const second = (await theirs.boundingBox())!;
    expect(second.y).toBeGreaterThan(first.y);
    await expect(theirs.locator('xpath=ancestor::*[@aria-live="polite"]')).toHaveCount(1);
    const left = (await theirs.locator('.artifact-comment-text').boundingBox())!;
    const right = (await answered.readers.first().locator('.artifact-comment-text').boundingBox())!;
    expect(left.x).toBeLessThan(right.x);
    // The reader's comment stays answered, and is drawn once.
    await expect(answered.readers).toHaveCount(1);
    await expect(answered.node.locator('.artifact-comment-typing')).toHaveCount(0);
    await expect(answered.toggle).toHaveText('Reply');
    await expect(page.getByText(FOLLOW, { exact: true })).toHaveCount(1);

    // Closed again, the thread is out of view: the reads stop.
    await findings.popover.getByRole('button', { name: 'Close' }).click();
    await expect(answered.node).toBeHidden();
    await pass(page, 30_000);
    const stopped = (await reads.times()).length;
    await pass(page, 120_000);
    expect(await reads.times()).toHaveLength(stopped);
    expect(reads.errors).toEqual([]);
  });

  test('a hidden page reads nothing, and reads at once when seen again', async ({ page }) => {
    const reads = await watchReads(page);
    await serve(page, () => ({ threads: [{ root: row({ state: 'pending' }), replies: [] }] }));
    await stopClock(page);
    await load(page);
    expect(await reads.times()).toHaveLength(1);
    await setVisibility(page, 'hidden');
    await pass(page, 120_000);
    expect(await reads.times()).toHaveLength(1);

    await setVisibility(page, 'visible');
    await expect.poll(async () => (await reads.times()).length).toBe(2);
    await pass(page, 3000);
    const times = await reads.times();
    expect(times).toHaveLength(3);
    expect(times[2] - times[1]).toBe(3000);
    expect(reads.errors).toEqual([]);
  });

  test('a read that finds the reader signed out says so once and stops', async ({ page }) => {
    const reads = await watchReads(page);
    const pending = row({ state: 'pending' });
    await serve(page, (n) => (n === 2 ? { status: 401 } : { threads: [{ root: pending, replies: [] }] }));
    await stopClock(page);
    await load(page);
    await pass(page, 120_000);
    expect(await reads.times()).toHaveLength(2);
    const findings = box(page, 'findings');
    await findings.summary.click();
    await expect(page.getByText(SIGNED_OUT)).toHaveCount(1);
    await expect(thread(page, pending).node.getByText(SIGNED_OUT)).toBeVisible();
    await expect(findings.popover.getByText(SIGNED_OUT)).toBeVisible();
    expect(reads.errors).toEqual([]);
  });

  test('a thread composer reads Add to your comment until an agent answers, then Reply', async ({ page }) => {
    const reads = await watchReads(page);
    const waiting = row({ state: 'pending' });
    const answered = row({ state: 'answered' });
    await serve(page, () => ({
      threads: [{ root: waiting, replies: [] }, { root: answered, replies: [reply(answered, 'Yes.')] }],
    }));
    await stopClock(page);
    await load(page);
    await box(page, 'findings').summary.click();

    const mine = thread(page, waiting);
    await expect(mine.toggle).toHaveText('Add to your comment');
    await expect(mine.toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(mine.field).toBeHidden();
    // The quiet voice, still legible.
    await expect(mine.toggle).toHaveCSS('color', 'rgb(148, 138, 173)');
    await mine.toggle.click();
    await expect(mine.toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.field).toBeVisible();
    await expect(mine.field).toBeFocused();
    await expect(mine.field).toHaveAttribute('placeholder', `Add detail. ${OWNER} reads it with your comment.`);

    const theirs = thread(page, answered);
    await expect(theirs.toggle).toHaveText('Reply');
    await expect(theirs.toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(theirs.field).toBeHidden();
    expect(reads.errors).toEqual([]);
  });

  test('a follow-up on an answered thread is drawn once, folds the composer and starts the reads again', async ({ page }) => {
    const reads = await watchReads(page);
    const root = row({ state: 'answered' });
    const answer = reply(root, 'Yes.');
    const replies: unknown[] = [answer];
    await serve(page, () => ({ threads: [{ root, replies: [...replies] }] }), (body) => {
      const posted = row({ parent: body.parent, text: body.text, state: 'pending' });
      replies.push(posted);
      return posted;
    });
    await stopClock(page);
    await load(page);
    await pass(page, 60_000);
    expect(await reads.times()).toHaveLength(1);

    await box(page, 'findings').summary.click();
    const answered = thread(page, root);
    await answered.toggle.click();
    await answered.field.fill('And the second pump?');
    await answered.send.click();
    await expect(answered.readers).toHaveCount(2);
    const followUp = answered.readers.nth(1);
    await expect(followUp.locator('.artifact-comment-text')).toHaveText('And the second pump?');
    await expect(answered.toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(answered.field).toBeHidden();
    const left = (await answered.agents.first().locator('.artifact-comment-text').boundingBox())!;
    const right = (await followUp.locator('.artifact-comment-text').boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x);

    await pass(page, 5000);
    expect((await reads.times()).length).toBeGreaterThanOrEqual(2);
    // The read returns the follow-up too: still drawn once.
    await expect(answered.readers).toHaveCount(2);
    await expect(page.getByText('And the second pump?', { exact: true })).toHaveCount(1);
    expect(reads.errors).toEqual([]);
  });

  test('a read that brings a reply elsewhere leaves an open composer as it was', async ({ page }) => {
    const reads = await watchReads(page);
    const typing = row({ state: 'pending' });
    const other = row({ state: 'pending', section: 'risks', sectionTitle: 'Risks' });
    await serve(page, (n) => ({
      threads: [
        { root: typing, replies: [] },
        n < 2 ? { root: other, replies: [] }
          : { root: { ...other, state: 'answered' }, replies: [reply(other, 'Fixed.')] },
      ],
    }));
    await stopClock(page);
    await load(page);
    // Only Findings is open: the reply lands in Risks, out of sight.
    await box(page, 'findings').summary.click();

    const mine = thread(page, typing);
    await mine.toggle.click();
    await mine.field.pressSequentially('Half a thought');
    await pass(page, 5000);
    expect((await reads.times()).length).toBeGreaterThanOrEqual(2);
    await expect(thread(page, other).agents).toHaveCount(1);
    await expect(mine.field).toHaveValue('Half a thought');
    await expect(mine.field).toBeFocused();
    expect(reads.errors).toEqual([]);
  });
});
