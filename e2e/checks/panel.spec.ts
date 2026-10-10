import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The side panel a wide window gets: the capture fixture's comments page at
// 1440 pixels, its threads in an aside folded to a rail of status dots, each
// section's box a one-line chip, and threads resolved and reopened. Most
// checks answer the threads route themselves; those that post go to the
// site, and as the run shares one database they show only the threads they
// made, found by id. hermes claims and replies through real `lotuspod`
// commands on the fixture's agent socket. The sections page shows the panel
// beside folded sections, and the five-section page the list of sections
// the panel starts a thread from.
const PAGE = '/capture-comments.html';
const SLUG = 'capture-comments';
const SECTIONS = '/capture-sections.html';
const SECTIONS_SLUG = 'capture-sections';
const FOLDED = `lotuspod:folded:${SECTIONS}`;
const FIVE = '/capture-panel.html';
const FIVE_SLUG = 'capture-panel';
const FIVE_TITLES = ['Findings', 'Risks', 'Heater', 'Costs', 'Next steps'];
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const OWNER = 'hermes';
const AGENT = { kind: 'agent', handle: OWNER };
const OPEN = { resolved: false, actor: null, at: null };
const RESOLVED = { resolved: true, actor: { kind: 'human', name: READER }, at: '2026-09-30T11:00:00.000Z' };
const WIDE = { width: 1440, height: 900 };
const START = Date.parse('2026-09-30T12:00:00Z');

test.use({ viewport: WIDE });

type Violation = { blockedURI: string; effectiveDirective: string };

// Errors, policy violations and how many reads are in flight.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
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

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    aside,
    landmark: page.getByRole('complementary', { name: 'Comments' }),
    rail: aside.locator('.artifact-comments-rail'),
    opener: aside.getByRole('button', { name: 'Comments', exact: true }),
    badge: aside.locator('.artifact-comments-badge'),
    dots: aside.locator('.artifact-comments-dot'),
    count: aside.locator('.artifact-comments-count'),
    showResolved: aside.locator('.artifact-comments-show-resolved'),
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    titles: aside.locator('.artifact-comments-group:not([hidden]) > .artifact-comments-group-title'),
    group: (title: string) => aside.locator('.artifact-comments-group')
      .filter({ has: page.locator('.artifact-comments-group-title', { hasText: title }) }),
    field: aside.locator('form.artifact-comment-form textarea[name="text"]'),
    send: aside.getByRole('button', { name: 'Comment', exact: true }),
  };
}

function entry(page: Page, root: { id: number }) {
  const item = page.locator(`.artifact-comments-entry[data-thread="${root.id}"]`);
  return {
    item,
    head: item.locator('.artifact-comments-entry-head'),
    mark: item.locator('.artifact-comments-entry-head .artifact-comments-entry-mark'),
    state: item.locator('.artifact-comments-entry-state'),
    resolved: item.locator('.artifact-comments-entry-resolved'),
    done: item.locator('.artifact-comments-entry-done'),
    resolve: item.getByRole('button', { name: 'Resolve' }),
    reopen: item.getByRole('button', { name: 'Reopen' }),
    readers: item.locator('.artifact-comment-item--reader'),
    agents: item.locator('.artifact-comment-item--agent'),
    thread: item.locator('.artifact-comment-thread'),
  };
}

function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  return { details, chip: details.locator(':scope > summary') };
}

// What each dot in the rail says, in order.
function dotKinds(dots: Locator) {
  return dots.evaluateAll((nodes) => nodes.map((node) =>
    (node.className.match(/artifact-comments-dot--(\w+)/) ?? ['', ''])[1]));
}

function running(target: Locator) {
  return target.evaluate((node) =>
    node.getAnimations().filter((animation) => animation.playState === 'running').length);
}

// Where a node is in the window.
function spot(target: Locator) {
  return target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
}

let next = 1;

function row(fields: Record<string, unknown>) {
  const id = next++;
  return {
    id,
    page: SLUG,
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

function reply(root: { id: number; section: string }, text: string) {
  return row({ parent: root.id, section: root.section, state: 'answered', text, actor: AGENT });
}

// Answer the threads route's reads in turn: the nth read (from 1) gets
// threads(n).
async function serve(page: Page, threads: (n: number) => unknown[], slug = SLUG) {
  let reads = 0;
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: slug, threads: threads(++reads) } }));
}

// The threads of the first criterion: an answered thread in Findings, one
// being written and one waiting in Risks, and a resolved one in Next steps.
// The thread being written is the older of the two in Risks, and its newest
// comment, a follow-up, is the newest there.
function sample() {
  const answered = row({ state: 'answered', text: 'Does the pump stop when the pond freezes?' });
  const answer = reply(answered, 'It does. It needs a heater beside it.');
  const writing = row({ state: 'answered', section: 'risks', sectionTitle: 'Risks', text: 'Can the pump crack?' });
  const writingAnswer = reply(writing, 'It can, below minus five.');
  const waiting = row({ state: 'pending', section: 'risks', sectionTitle: 'Risks', text: 'Who checks it each morning?' });
  const followUp = row({ parent: writing.id, section: 'risks', sectionTitle: 'Risks', state: 'claimed', text: 'And at minus ten?' });
  const resolved = row({ state: 'answered', section: 'next-steps', sectionTitle: 'Next steps', text: 'Which heater fits?' });
  const resolvedAnswer = reply(resolved, 'A floating one.');
  return {
    answered, writing, waiting, resolved,
    threads: [
      { root: answered, replies: [answer], resolution: OPEN },
      { root: writing, replies: [writingAnswer, followUp], resolution: OPEN },
      { root: waiting, replies: [], resolution: OPEN },
      { root: resolved, replies: [resolvedAnswer], resolution: RESOLVED },
    ],
  };
}

// Show only the threads this check made: the site answers every read and
// post, and a read is cut to the threads whose ids posts returned.
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

// Threads on the five-section page, by section id, with ids far from those
// the site gives, so they never meet a thread a check posts.
function onFive(sections: Record<string, string>, resolution = OPEN) {
  return Object.entries(sections).map(([section, sectionTitle], index) => ({
    root: row({
      id: 900_000 + next++, page: FIVE_SLUG, section, sectionTitle, state: 'pending',
      text: `On ${sectionTitle}?`, createdAt: `2026-09-30T10:0${index}:00.000Z`,
    }),
    replies: [],
    resolution,
  }));
}

// Answer each read with the given threads and the site's threads whose ids
// posts returned; posts go to the site.
async function withOwn(page: Page, threads: unknown[], ids: Set<number>) {
  await page.route((url) => url.pathname === '/api/comments', async (route) => {
    const request = route.request();
    const response = await route.fetch();
    const body = await response.json();
    if (request.method() === 'GET' && Array.isArray(body.threads)) {
      body.threads = [...threads, ...body.threads.filter((thread: any) => ids.has(thread.root.id))];
    } else if (response.status() === 201 && body.parent === null) {
      ids.add(body.id);
    }
    await route.fulfill({ response, json: body });
  });
}

async function post(request: APIRequestContext, section: string, text: string) {
  const response = await request.post('/api/comments', { data: { page: SLUG, section, text } });
  expect(response.status()).toBe(201);
  return response.json();
}

async function readThread(request: APIRequestContext, id: number) {
  const response = await request.get(`/api/comments?page=${SLUG}`);
  expect(response.status()).toBe(200);
  return (await response.json()).threads.find((thread: any) => thread.root.id === id);
}

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

async function load(page: Page, url = PAGE) {
  await page.goto(`${url}?standalone`);
  await expect(page.locator('.artifact-body details.artifact-comment')).toHaveCount(3);
  await settle(page);
}

// The five-section page with the panel open.
async function loadFive(page: Page) {
  await page.goto(`${FIVE}?standalone`);
  await expect(page.locator('.artifact-body details.artifact-comment')).toHaveCount(5);
  await settle(page);
  const side = panel(page);
  await side.opener.click();
  await expect(side.fold).toBeVisible();
  return side;
}

// A long review on the five-section page: two open threads in Findings, and
// three resolved, one in Risks and two in Costs.
function review() {
  return [
    ...onFive({ findings: 'Findings' }),
    ...onFive({ findings: 'Findings' }),
    ...onFive({ risks: 'Risks' }, RESOLVED),
    ...onFive({ costs: 'Costs' }, RESOLVED),
    ...onFive({ costs: 'Costs' }, RESOLVED),
  ];
}

// Answer reads with the threads as they now stand, and a post resolving or
// reopening one by changing it.
async function serveReview(page: Page, threads: any[]) {
  await page.route((url) => url.pathname === '/api/comments', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      const thread = threads.find((each) => each.root.id === body.thread);
      thread.resolution = body.resolved ? RESOLVED : OPEN;
      await route.fulfill({ json: { page: FIVE_SLUG, thread: body.thread, resolution: thread.resolution } });
      return;
    }
    await route.fulfill({ json: { page: FIVE_SLUG, threads } });
  });
}

// The panel's one way to start a thread on a section.
function picker(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    button: aside.getByRole('button', { name: 'Comment on a section' }),
    list: aside.getByRole('listbox', { name: 'Sections' }),
    options: aside.getByRole('option'),
    none: aside.getByText('No comments yet'),
    perSection: aside.getByRole('button', { name: 'Comment on this section' }),
  };
}

// Focus target from the keyboard: Tab until it has focus.
async function tabTo(page: Page, target: Locator) {
  for (let presses = 0; presses < 80; presses += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('the keyboard never reached the target');
}

async function outlined(target: Locator) {
  const style = await target.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { style: computed.outlineStyle, width: parseFloat(computed.outlineWidth) };
  });
  expect(style.style).toBe('solid');
  expect(style.width).toBeGreaterThanOrEqual(2);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('the panel starts folded to a rail of one dot per open thread beside the column', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    const { threads } = sample();
    await serve(page, () => threads);
    await load(page);
    const side = panel(page);
    await expect(side.landmark).toBeVisible();
    await expect(side.opener).toBeVisible();
    await expect(side.opener).toHaveAttribute('aria-expanded', 'false');
    const rail = (await side.aside.boundingBox())!;
    const column = (await page.locator('.artifact-body').boundingBox())!;
    expect(rail.width).toBeLessThanOrEqual(44);
    expect(rail.x).toBeGreaterThanOrEqual(column.x + column.width);
    await expect(side.badge).toHaveText('3');
    await expect(side.dots).toHaveCount(3);
    expect(await dotKinds(side.dots)).toEqual(['answered', 'writing', 'waiting']);
    expect(await running(side.dots.nth(0))).toBe(0);
    expect(await running(side.dots.nth(1))).toBeGreaterThan(0);
    expect(await running(side.dots.nth(2))).toBe(0);
    await seen.clean();
  });

  test('the rail opens the panel grouped by section without moving the column, and the page remembers it', async ({ page }) => {
    const seen = await watch(page);
    const { answered, writing, waiting, resolved, threads } = sample();
    await serve(page, () => threads);
    await load(page);
    const side = panel(page);
    const paragraph = page.getByText('The pond freezes in January, and the pump stops with it.');
    const before = await spot(paragraph);
    await side.opener.click();
    await expect(side.fold).toBeVisible();
    await expect(side.opener).toBeHidden();
    await expect.poll(async () => (await side.aside.boundingBox())!.width).toBeGreaterThan(300);
    expect((await side.aside.boundingBox())!.width).toBeLessThanOrEqual(330);
    await expect(side.count).toHaveText('3 open · 1 resolved');
    await expect(side.titles).toHaveText(['Findings', 'Risks']);
    await expect(side.group('Findings').locator('.artifact-comments-entry')).toHaveCount(1);
    await expect(side.group('Risks').locator('.artifact-comments-entry')).toHaveCount(2);
    for (const root of [answered, writing, waiting]) {
      await expect(entry(page, root).mark).toHaveText('§');
    }
    await expect(entry(page, answered).state).toContainText('✓ Answered');
    await expect(entry(page, answered).state).toContainText('1 reply');
    await expect(entry(page, writing).state).toContainText(`${OWNER} is writing`);
    await expect(entry(page, waiting).state).toContainText(`Waiting for ${OWNER}`);
    const done = entry(page, resolved);
    await expect(done.item).toBeHidden();
    await side.showResolved.click();
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Next steps']);
    await expect(side.group('Next steps').locator('.artifact-comments-entry')).toHaveCount(1);
    await expect(done.head).toBeHidden();
    await expect(done.resolved).toBeVisible();
    await expect(done.resolved.locator('.artifact-comments-entry-mark')).toHaveText('§');
    await expect(done.done).toHaveText('✓ resolved · Reopen');
    expect(await spot(paragraph)).toEqual(before);

    await page.reload();
    await settle(page);
    await expect(side.fold).toBeVisible();
    await expect(side.count).toHaveText('3 open · 1 resolved');

    // Storage that throws on every access: folded, and the rail still opens it.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('Storage is off', 'SecurityError'); },
      });
    });
    await page.reload();
    await settle(page);
    expect(await page.evaluate(() => {
      try { return typeof window.localStorage; } catch (error) { return 'throws'; }
    })).toBe('throws');
    await expect(side.opener).toBeVisible();
    await expect(side.opener).toHaveAttribute('aria-expanded', 'false');
    await side.opener.click();
    await expect(side.fold).toBeVisible();
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Next steps']);
    await seen.clean();
  });

  test('each section box is a chip that opens its newest thread in the panel and never itself', async ({ page }) => {
    const seen = await watch(page);
    const { writing, threads } = sample();
    await serve(page, () => threads);
    await load(page);
    const findings = box(page, 'findings');
    const risks = box(page, 'risks');
    const steps = box(page, 'next-steps');
    await expect(findings.chip).toHaveText('1 reply · ✓ hermes answered');
    await expect(risks.chip).toHaveText('hermes is writing…');
    await expect(steps.chip).toHaveText('No comments · Comment');
    // The faces before the words are hidden from assistive technology.
    await expect(findings.chip).toHaveAccessibleName('1 reply · hermes answered');
    await expect(findings.chip.locator('.artifact-comment-chip-faces')).toHaveAttribute('aria-hidden', 'true');

    const height = (await risks.details.boundingBox())!.height;
    await risks.chip.click();
    await expect(panel(page).fold).toBeVisible();
    await expect(risks.details).not.toHaveAttribute('open');
    expect((await risks.details.boundingBox())!.height).toBe(height);
    const thread = entry(page, writing);
    await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
    await expect(thread.thread).toBeVisible();
    await expect(thread.readers).toHaveCount(2);
    await expect(thread.item.locator('.artifact-comment-typing--claimed .artifact-comment-by'))
      .toHaveText(`${OWNER} AGENT is writing`);

    // From the keyboard, Enter on a chip opens the panel too, never the box.
    await panel(page).fold.click();
    await findings.chip.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).fold).toBeVisible();
    await expect(findings.details).not.toHaveAttribute('open');
    await panel(page).fold.click();
    await findings.chip.focus();
    await page.keyboard.press(' ');
    await expect(panel(page).fold).toBeVisible();
    await expect(findings.details).not.toHaveAttribute('open');
    await seen.clean();
  });

  test('a section whose newest comment waits reads its count and waiting', async ({ page }) => {
    const seen = await watch(page);
    const { threads } = sample();
    const pending = row({ state: 'pending', section: 'next-steps', sectionTitle: 'Next steps' });
    await serve(page, () => [...threads, { root: pending, replies: [], resolution: OPEN }]);
    await load(page);
    await expect(box(page, 'next-steps').chip).toHaveText('1 comment · waiting');
    await seen.clean();
  });

  test('a comment written in the panel starts a thread there and the column stays still', async ({ page }) => {
    const seen = await watch(page);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page);
    const side = panel(page);
    const steps = box(page, 'next-steps');
    const paragraph = page.getByText('Fit a heater before the first frost.');
    // Clicking scrolls a chip at the window's edge into view first.
    await steps.chip.scrollIntoViewIfNeeded();
    const before = await spot(paragraph);
    await expect(steps.chip).toHaveText('No comments · Comment');
    await steps.chip.click();
    const field = side.group('Next steps').locator('textarea[name="text"]');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    const COMMENT = 'Who fits the heater?';
    await field.fill(COMMENT);
    await side.group('Next steps').getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => ids.size).toBe(1);
    const [id] = [...ids];
    const mine = entry(page, { id });
    await expect(side.group('Next steps').locator('.artifact-comments-entry')).toHaveCount(1);
    await expect(mine.item).toBeVisible();
    await expect(mine.readers.locator('.artifact-comment-text')).toHaveText(COMMENT);
    await expect(steps.chip).toHaveText('1 comment · waiting');
    await expect(steps.details).not.toHaveAttribute('open');
    expect(await spot(paragraph)).toEqual(before);

    await page.reload();
    await settle(page);
    await expect(side.fold).toBeVisible();
    await expect(side.group('Next steps').locator(`.artifact-comments-entry[data-thread="${id}"]`)).toHaveCount(1);
    await expect(mine.head.locator('.artifact-comments-entry-words')).toHaveText(COMMENT);
    await expect(steps.chip).toHaveText('1 comment · waiting');
    await seen.clean();
  });

  test("hermes's claim and reply land in the open panel thread and the chip reads answered", async ({ page }) => {
    test.setTimeout(120_000);
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    const seen = await watch(page);
    // hermes pulls first, so it is listening and the comment waits for it.
    hermes('pull', '--owner', OWNER);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    const side = panel(page);
    const findings = box(page, 'findings');
    const paragraph = page.getByText('The pond freezes in January, and the pump stops with it.');
    const before = await spot(paragraph);
    await findings.chip.click();
    const group = side.group('Findings');
    await group.locator('textarea[name="text"]').fill('Does the pump need a heater of its own?');
    await group.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => ids.size).toBe(1);
    const [id] = [...ids];
    const mine = entry(page, { id });
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.thread).toBeVisible();
    expect(await spot(paragraph)).toEqual(before);

    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe(OWNER);
    await expect(mine.item.locator('.artifact-comment-typing--claimed .artifact-comment-by'))
      .toHaveText(`${OWNER} AGENT is writing`, { timeout: 15_000 });
    await expect(findings.chip).toHaveText(`${OWNER} is writing…`);
    expect(await spot(paragraph)).toEqual(before);

    const REPLY = 'Yes: a floating heater beside the pump.';
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `panel-${id}`, '--text', REPLY);
    await expect(mine.agents).toHaveCount(1, { timeout: 15_000 });
    const theirs = mine.agents.first();
    await expect(theirs.locator('.artifact-comment-text')).toHaveText(REPLY);
    // A left-hand bubble: behind an avatar left of the reader's.
    const left = (await theirs.locator('.artifact-comment-avatar').boundingBox())!;
    const right = (await mine.readers.first().locator('.artifact-comment-avatar').boundingBox())!;
    const bubble = (await theirs.locator('.artifact-comment-text').boundingBox())!;
    expect(left.x).toBeLessThan(right.x);
    expect(bubble.x).toBeGreaterThan(left.x);
    // The reply is the reader's to read: counted until the thread next opens.
    await expect(findings.chip).toHaveText(`1 reply · ✓ ${OWNER} answered · 1 new`);
    await side.fold.click();
    expect(await dotKinds(side.dots)).toEqual(['answered']);
    expect(await spot(paragraph)).toEqual(before);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    await seen.clean();
  });

  test('Resolve takes a thread out of the list, shown it is a dashed line, and Reopen brings it back', async ({ page, request }) => {
    test.setTimeout(120_000);
    const seen = await watch(page);
    hermes('pull', '--owner', OWNER);
    const asked = await post(request, 'findings', 'Is the outlet on its own fuse?');
    const other = await post(request, 'risks', 'What if the heater fails too?');
    const claim = hermes('claim', String(asked.id));
    hermes('reply', String(asked.id), `--claim=${claim.claimToken}`, '--key', `panel-resolve-${asked.id}`,
      '--text', 'It is, since the spring.');
    const ids = new Set<number>([asked.id, other.id]);
    await ownThreads(page, ids);
    await load(page);
    const side = panel(page);
    await expect(side.badge).toHaveText('2');
    await box(page, 'findings').chip.click();
    const thread = entry(page, asked);
    await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
    await expect(thread.agents).toHaveCount(1);
    await thread.resolve.click();
    await expect(thread.item).toBeHidden();
    await expect(side.titles).toHaveText(['Risks']);
    await expect(side.showResolved).toHaveText('Show resolved (1)');
    await expect(side.showResolved).toBeFocused();
    await expect(side.count).toHaveText('1 open · 1 resolved');
    await expect(side.badge).toHaveText('1');
    await expect(box(page, 'findings').chip).toHaveText('No comments · Comment');
    const stored = await readThread(request, asked.id);
    expect(stored.resolution.resolved).toBe(true);
    expect(stored.resolution.actor).toEqual({ kind: 'human', name: READER });
    await side.showResolved.click();
    await expect(thread.done).toBeVisible();
    await expect(thread.done).toHaveText('✓ resolved · Reopen');
    await expect(thread.head).toBeHidden();
    await expect(thread.readers).toBeHidden();

    await page.reload();
    await settle(page);
    await expect(thread.done).toBeVisible();
    await expect(thread.done).toHaveText('✓ resolved · Reopen');
    await side.fold.click();
    await expect(side.badge).toHaveText('1');
    await expect(side.dots).toHaveCount(1);

    await side.opener.click();
    await thread.reopen.click();
    await expect(thread.resolved).toBeHidden();
    await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
    await expect(thread.readers).toHaveCount(1);
    await expect(thread.agents).toHaveCount(1);
    await expect(thread.readers.first()).toBeVisible();
    await expect(side.count).toHaveText('2 open · 0 resolved');
    await side.fold.click();
    await expect(side.badge).toHaveText('2');
    expect((await readThread(request, asked.id)).resolution.resolved).toBe(false);
    await seen.clean();
  });

  test('a thread in a folded section is listed, opens its section and counts as new', async ({ page }) => {
    const seen = await watch(page);
    const root = row({
      page: SECTIONS_SLUG, section: 'next-steps', sectionTitle: 'Next steps', state: 'pending',
      text: 'When does the heater go in?',
    });
    await page.route((url) => url.pathname === '/api/answers', (route) =>
      route.fulfill({ json: { page: SECTIONS_SLUG, questions: {} } }));
    await serve(page, (n) => [n < 2
      ? { root, replies: [], resolution: OPEN }
      : { root: { ...root, state: 'answered' }, replies: [reply(root, 'Before the first frost.')], resolution: OPEN },
    ], SECTIONS_SLUG);
    await page.addInitScript(([key, value]) => {
      if (!sessionStorage.getItem('__remembered')) {
        sessionStorage.setItem('__remembered', '1');
        localStorage.setItem(key, value);
      }
    }, [FOLDED, JSON.stringify(['next-steps'])]);
    await page.clock.install({ time: START });
    await page.clock.pauseAt(START + 1000);
    await load(page, SECTIONS);
    const heading = page.locator('h2#next-steps button.artifact-section-toggle');
    const wrapper = page.locator('div.artifact-section-body[data-section="next-steps"]');
    const mark = page.locator('h2#next-steps .artifact-section-mark:not([hidden])');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    const side = panel(page);
    await side.opener.click();
    const listed = side.group('Next steps').locator(`.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(listed).toHaveCount(1);
    await entry(page, root).head.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await expect(wrapper).not.toHaveAttribute('hidden');
    await expect(box(page, 'next-steps').chip).toBeInViewport();

    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(mark).toHaveCount(0);
    for (let done = 0; done < 5000; done += 1000) {
      await page.clock.runFor(1000);
      await settle(page);
    }
    await expect(entry(page, root).agents).toHaveCount(1);
    await expect(mark).toHaveText('1 new');
    await seen.clean();
  });

  test('the keyboard reaches the rail, an entry and Resolve, each outlined, and Escape folds', async ({ page }) => {
    const seen = await watch(page);
    const { answered, threads } = sample();
    await serve(page, () => threads);
    await load(page);
    const side = panel(page);
    await tabTo(page, side.opener);
    await outlined(side.opener);
    await page.keyboard.press('Enter');
    await expect(side.fold).toBeFocused();
    const first = entry(page, answered);
    await tabTo(page, first.head);
    await outlined(first.head);
    await page.keyboard.press('Enter');
    await expect(first.head).toHaveAttribute('aria-expanded', 'true');
    await tabTo(page, first.resolve);
    await outlined(first.resolve);
    await page.keyboard.press('Escape');
    await expect(side.fold).toBeHidden();
    await expect(side.opener).toBeFocused();
    await expect(side.opener).toHaveAttribute('aria-expanded', 'false');
    await seen.clean();
  });

  test('under reduced motion the writing dot keeps still and the panel does not slide', async ({ page }) => {
    const seen = await watch(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { threads } = sample();
    await serve(page, () => threads);
    await load(page);
    const side = panel(page);
    expect(await dotKinds(side.dots)).toEqual(['answered', 'writing', 'waiting']);
    expect(await running(side.dots.nth(1))).toBe(0);
    await expect(side.aside).toHaveCSS('transition-duration', '0s');
    await side.opener.click();
    await expect(side.aside).toHaveCSS('transition-duration', '0s');
    await seen.clean();
  });

  test('the panel lists only the sections with threads, and one control starts a thread on any section', async ({ page }) => {
    const seen = await watch(page);
    const ids = new Set<number>();
    await withOwn(page, onFive({ findings: 'Findings', costs: 'Costs' }), ids);
    const side = await loadFive(page);
    const pick = picker(page);
    await expect(side.titles).toHaveText(['Findings', 'Costs']);
    await expect(pick.perSection).toHaveCount(0);
    await expect(pick.none).toBeHidden();
    // Under the heading, above the groups.
    const head = (await side.aside.locator('.artifact-comments-head').boundingBox())!;
    const button = (await pick.button.boundingBox())!;
    const groups = (await side.aside.locator('.artifact-comments-groups').boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(button.y + button.height).toBeLessThanOrEqual(groups.y);
    await expect(pick.button).toHaveAttribute('aria-expanded', 'false');

    await pick.button.click();
    await expect(pick.button).toHaveAttribute('aria-expanded', 'true');
    await expect(pick.list).toBeVisible();
    await expect(pick.options).toHaveText(['This page', ...FIVE_TITLES]);
    await pick.options.nth(3).click();
    await expect(pick.list).toBeHidden();
    const heater = side.group('Heater');
    const field = heater.getByLabel('Comment on Heater');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(side.titles).toHaveText(['Findings', 'Heater', 'Costs']);
    const COMMENT = 'Which heater fits the outlet?';
    await field.fill(COMMENT);
    await heater.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => ids.size).toBe(1);
    const [id] = [...ids];
    const mine = entry(page, { id });
    await expect(heater.locator('.artifact-comments-entry')).toHaveCount(1);
    await expect(mine.readers.locator('.artifact-comment-text')).toHaveText(COMMENT);
    await expect(field).toBeHidden();
    await expect(side.titles).toHaveText(['Findings', 'Heater', 'Costs']);
    await expect(pick.perSection).toHaveCount(0);

    await page.reload();
    await settle(page);
    await expect(side.titles).toHaveText(['Findings', 'Heater', 'Costs']);
    await seen.clean();
  });

  test('the keyboard picks a section from the list, and Escape or a click outside closes it to its control', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, () => onFive({ findings: 'Findings', costs: 'Costs' }), FIVE_SLUG);
    const side = await loadFive(page);
    const pick = picker(page);
    await tabTo(page, pick.button);
    await outlined(pick.button);
    await page.keyboard.press('Enter');
    await expect(pick.list).toBeVisible();
    await expect(pick.list).toBeFocused();
    // This page comes first, then the sections.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(pick.options.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(pick.list).toHaveAttribute('aria-activedescendant', (await pick.options.nth(2).getAttribute('id'))!);
    await page.keyboard.press('Enter');
    await expect(pick.list).toBeHidden();
    const field = side.group('Risks').locator('textarea[name="text"]');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Costs']);

    await pick.button.focus();
    await page.keyboard.press('Enter');
    await expect(pick.list).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(pick.list).toBeHidden();
    await expect(pick.button).toBeFocused();
    await expect(pick.button).toHaveAttribute('aria-expanded', 'false');
    // Escape closed the list, never the panel.
    await expect(side.fold).toBeVisible();

    await pick.button.click();
    await expect(pick.list).toBeVisible();
    await side.count.click();
    await expect(pick.list).toBeHidden();
    await expect(pick.button).toBeFocused();
    await seen.clean();
  });

  test('a page with no threads says so above the control', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, () => [], FIVE_SLUG);
    const side = await loadFive(page);
    const pick = picker(page);
    await expect(pick.none).toBeVisible();
    await expect(pick.button).toBeVisible();
    expect((await pick.none.boundingBox())!.y).toBeLessThan((await pick.button.boundingBox())!.y);
    await expect(side.titles).toHaveCount(0);
    await expect(pick.perSection).toHaveCount(0);
    await seen.clean();
  });

  test('a section with only a resolved thread is listed once resolved threads are shown', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, () => onFive({ heater: 'Heater' }, RESOLVED), FIVE_SLUG);
    const side = await loadFive(page);
    await expect(side.count).toHaveText('0 open · 1 resolved');
    await expect(side.titles).toHaveCount(0);
    await expect(picker(page).none).toBeHidden();
    await side.showResolved.click();
    await expect(side.titles).toHaveText(['Heater']);
    await seen.clean();
  });

  test('resolved threads are hidden until the reader shows them, and the page remembers it for the session', async ({ page, browser }) => {
    const seen = await watch(page);
    const threads = review();
    const [first, second, risk, cost, other] = threads.map((thread) => thread.root);
    await serveReview(page, threads);
    const side = await loadFive(page);
    await expect(side.count).toHaveText('2 open · 3 resolved');
    await expect(side.titles).toHaveText(['Findings']);
    await expect(side.group('Findings').locator('.artifact-comments-entry:visible')).toHaveCount(2);
    for (const root of [risk, cost, other]) {
      await expect(entry(page, root).item).toBeHidden();
    }
    await expect(side.showResolved).toHaveText('Show resolved (3)');
    await expect(side.showResolved).toHaveAttribute('aria-pressed', 'false');
    // Beside the counts, in the panel's head.
    const head = (await side.aside.locator('.artifact-comments-head').boundingBox())!;
    const control = (await side.showResolved.boundingBox())!;
    expect(control.y).toBeGreaterThanOrEqual(head.y);
    expect(control.y + control.height).toBeLessThanOrEqual(head.y + head.height);
    // The rail's dots stay the open threads'.
    await side.fold.click();
    await expect(side.dots).toHaveCount(2);
    await side.opener.click();

    await side.showResolved.click();
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Costs']);
    for (const root of [risk, cost, other]) {
      await expect(entry(page, root).done).toBeVisible();
      await expect(entry(page, root).done).toHaveText('✓ resolved · Reopen');
    }
    await expect(side.showResolved).toHaveText('Hide resolved');
    await expect(side.showResolved).toHaveAttribute('aria-pressed', 'true');
    await expect(entry(page, first).head).toBeVisible();
    await expect(entry(page, second).head).toBeVisible();

    await page.reload();
    await settle(page);
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Costs']);
    await expect(entry(page, risk).done).toBeVisible();
    await expect(side.showResolved).toHaveText('Hide resolved');
    await expect(side.showResolved).toHaveAttribute('aria-pressed', 'true');
    await seen.clean();

    // A new session starts with them hidden.
    const fresh = await browser.newContext({ viewport: WIDE, extraHTTPHeaders: SIGNED_IN });
    try {
      const again = await fresh.newPage();
      const watched = await watch(again);
      await serveReview(again, review());
      const sideAgain = await loadFive(again);
      await expect(sideAgain.titles).toHaveText(['Findings']);
      await expect(sideAgain.showResolved).toHaveText('Show resolved (3)');
      await expect(sideAgain.showResolved).toHaveAttribute('aria-pressed', 'false');
      await watched.clean();
    } finally {
      await fresh.close();
    }
  });

  test('a resolved thread reopened while shown moves among the open ones, and one resolved while hidden leaves the list', async ({ page }) => {
    const seen = await watch(page);
    const threads = review();
    const [first, , risk, cost] = threads.map((thread) => thread.root);
    await serveReview(page, threads);
    const side = await loadFive(page);
    await side.showResolved.click();
    await entry(page, cost).reopen.click();
    const reopened = entry(page, cost);
    await expect(reopened.resolved).toBeHidden();
    await expect(reopened.head).toBeVisible();
    await expect(reopened.head).toHaveAttribute('aria-expanded', 'true');
    await expect(side.count).toHaveText('3 open · 2 resolved');
    await expect(side.showResolved).toHaveText('Hide resolved');

    // Hidden again: the reopened thread stays among the open ones, its
    // section with it, and the control counts one fewer.
    await side.showResolved.click();
    await expect(side.showResolved).toHaveText('Show resolved (2)');
    await expect(side.titles).toHaveText(['Findings', 'Costs']);
    await expect(side.group('Costs').locator('.artifact-comments-entry:visible')).toHaveCount(1);
    await expect(reopened.head).toBeVisible();
    await expect(entry(page, risk).item).toBeHidden();

    // Resolved while hidden, a thread leaves the list.
    await entry(page, first).head.click();
    await entry(page, first).resolve.click();
    await expect(entry(page, first).item).toBeHidden();
    await expect(side.showResolved).toHaveText('Show resolved (3)');
    await expect(side.count).toHaveText('2 open · 3 resolved');
    await expect(side.titles).toHaveText(['Findings', 'Costs']);
    await seen.clean();
  });

  test('a page with no resolved threads draws no control to show them', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, () => onFive({ findings: 'Findings', costs: 'Costs' }), FIVE_SLUG);
    const side = await loadFive(page);
    await expect(side.count).toHaveText('2 open · 0 resolved');
    await expect(side.aside.getByRole('button', { name: /resolved/ })).toHaveCount(0);
    await expect(side.showResolved).toBeHidden();
    await seen.clean();
  });

  test('with storage that throws, resolved threads still show and hide', async ({ page }) => {
    const seen = await watch(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() { throw new DOMException('Storage is off', 'SecurityError'); },
      });
    });
    const threads = review();
    const [, , risk] = threads.map((thread) => thread.root);
    await serveReview(page, threads);
    const side = await loadFive(page);
    expect(await page.evaluate(() => {
      try { return typeof window.sessionStorage; } catch (error) { return 'throws'; }
    })).toBe('throws');
    await expect(side.titles).toHaveText(['Findings']);
    await side.showResolved.click();
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Costs']);
    await expect(entry(page, risk).done).toBeVisible();
    await expect(side.showResolved).toHaveAttribute('aria-pressed', 'true');
    await side.showResolved.click();
    await expect(side.titles).toHaveText(['Findings']);
    await expect(entry(page, risk).item).toBeHidden();
    await expect(side.showResolved).toHaveText('Show resolved (3)');
    await seen.clean();
  });

  test("a chip for a section with no threads opens that section's form in the panel", async ({ page }) => {
    const seen = await watch(page);
    await serve(page, () => onFive({ findings: 'Findings', costs: 'Costs' }), FIVE_SLUG);
    const side = await loadFive(page);
    await expect(side.titles).toHaveText(['Findings', 'Costs']);
    const risks = box(page, 'risks');
    await expect(risks.chip).toHaveText('No comments · Comment');
    await risks.chip.click();
    await expect(risks.details).not.toHaveAttribute('open');
    const field = side.group('Risks').locator('textarea[name="text"]');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(side.titles).toHaveText(['Findings', 'Risks', 'Costs']);
    await seen.clean();
  });

  test('at 1024 pixels a chip opens a popover, never its box, its thread moves with the window, and no width scrolls sideways', async ({ page }) => {
    const seen = await watch(page);
    const { answered, threads } = sample();
    await serve(page, () => threads);
    await page.setViewportSize({ width: 1024, height: 768 });
    await load(page);
    const side = panel(page);
    await expect(side.aside).toBeHidden();
    await expect(side.opener).toBeHidden();
    const findings = box(page, 'findings');
    await expect(findings.chip).toHaveText('1 reply · ✓ hermes answered');
    await findings.chip.click();
    await expect(findings.details).not.toHaveAttribute('open');
    const popover = page.locator('.artifact-comments-popover');
    await expect(popover.locator(`.artifact-comment-thread[data-thread="${answered.id}"]`)).toBeVisible();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${answered.id}"]`)).toHaveCount(1);

    const fits = () => page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    }));
    // The open thread moves to the phone's bottom sheet, drawn once.
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(side.aside).toBeHidden();
    await expect(popover).toBeHidden();
    await expect(findings.details).not.toHaveAttribute('open');
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    await expect(sheet.locator(`.artifact-comment-thread[data-thread="${answered.id}"]`)).toBeVisible();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${answered.id}"]`)).toHaveCount(1);
    let widths = await fits();
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);

    await page.setViewportSize(WIDE);
    await expect(side.aside).toBeVisible();
    await expect(findings.details).not.toHaveAttribute('open');
    await expect(findings.chip).toHaveText('1 reply · ✓ hermes answered');
    // The thread open in the sheet opens the panel at its entry.
    await expect(side.fold).toBeVisible();
    await expect(entry(page, answered).head).toHaveAttribute('aria-expanded', 'true');
    await expect(entry(page, answered).item.locator('.artifact-comment-thread')).toBeVisible();
    widths = await fits();
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
    await seen.clean();
  });
});
