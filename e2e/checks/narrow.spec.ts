import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Windows without room for the comments panel: at 1024 pixels a thread opens
// in a popover under its chip or highlight, over the text; at 360 pixels, a
// phone, in a bottom sheet whose arrows step through every open thread on
// the page. The capture fixture's comments and passages pages. Most checks
// answer the threads route themselves; those that post go to the site, and
// as the run shares one database they show only the threads they made,
// found by id. hermes claims and replies through real `lotuspod` commands on
// the fixture's agent socket.
const COMMENTS = '/capture-comments.html';
const PASSAGES = '/capture-passages.html';
const PASSAGES_SLUG = 'capture-passages';
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
const MEDIUM = { width: 1024, height: 768 };
const PHONE = { width: 360, height: 740 };

const HEATER = 'heater on the north wall';
const HEATER_QUOTE = {
  exact: HEATER,
  prefix: 'ops when the water freezes. The ',
  suffix: ' keeps the outlet clear, and the',
};
const FLOODS = 'floods the bed';
const FLOODS_QUOTE = { exact: FLOODS, prefix: 'A cracked pump ', suffix: ' below it.' };

test.use({ viewport: MEDIUM });

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

let next = 1;

function row(fields: Record<string, unknown>) {
  const id = 700_000 + next++;
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
    state: 'answered',
    ...fields,
  };
}

function answer(root: { id: number }, text: string) {
  return row({ page: (root as any).page, parent: root.id, state: 'answered', text, actor: AGENT });
}

// Answer every read of the threads route with threads.
async function serve(page: Page, threads: unknown[]) {
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: 'any', threads } }));
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

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

async function load(page: Page, where: string) {
  await page.goto(where);
  await expect(page.locator('.artifact-body details.artifact-comment')).toHaveCount(3);
  await settle(page);
}

function chip(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  return { details, chip: details.locator(':scope > summary') };
}

function popover(page: Page) {
  const node = page.locator('.artifact-comments-popover');
  return {
    node,
    title: node.locator('.artifact-comments-held-title'),
    close: node.getByRole('button', { name: 'Close' }),
    field: node.locator('form.artifact-comment-form textarea[name="text"]'),
    send: node.getByRole('button', { name: 'Comment', exact: true }),
    thread: (id: number) => node.locator(`.artifact-comment-thread[data-thread="${id}"]`),
    threads: node.locator('.artifact-comment-thread'),
  };
}

function sheet(page: Page) {
  const node = page.locator('.artifact-comments-bottom-sheet');
  return {
    node,
    title: node.locator('.artifact-comments-held-title'),
    at: node.locator('.artifact-comments-bottom-sheet-at'),
    state: node.locator('.artifact-comments-held-state'),
    back: node.getByRole('button', { name: 'Previous thread' }),
    forth: node.getByRole('button', { name: 'Next thread' }),
    close: node.getByRole('button', { name: 'Close' }),
    thread: (id: number) => node.locator(`.artifact-comment-thread[data-thread="${id}"]`),
  };
}

function marks(page: Page, id: number) {
  return page.locator(`.artifact-body mark.artifact-passage[data-thread="${id}"]`);
}

function rect(target: Locator) {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
  });
}

// Where a node is in the page, wherever the window is scrolled to.
function inPage(target: Locator) {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { top: box.top + window.scrollY, left: box.left + window.scrollX, width: box.width, height: box.height };
  });
}

function widths(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
  }));
}

// The sheet once it has slid all the way up.
async function risen(page: Page) {
  const node = sheet(page).node;
  await expect(node).toBeVisible();
  await expect.poll(async () => Math.round((await rect(node)).bottom)).toBe(page.viewportSize()!.height);
}

// Select words of the body's text through the Selection API: the first text
// node holding them, from their first character to their last.
async function choose(page: Page, words: string) {
  const chosen = await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector('.artifact-body')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(wanted);
      if (at < 0) continue;
      node.parentElement!.scrollIntoView({ block: 'center' });
      document.getSelection()!.setBaseAndExtent(node, at, node, at + wanted.length);
      return String(document.getSelection());
    }
    return null;
  }, words);
  expect(chosen).toBe(words);
}

// Where the selection is in the window.
function selectionRect(page: Page) {
  return page.evaluate(() => {
    const box = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  });
}

// Three open threads on the passages page: one on the heater's words and a
// section thread in Findings, one on the flood's words in Risks.
function passageThreads() {
  const page = PASSAGES_SLUG;
  const heater = row({ page, text: 'Is the heater still on the north wall?', quote: HEATER_QUOTE });
  const floods = row({
    page, section: 'risks', sectionTitle: 'Risks', text: 'How far does it flood?', quote: FLOODS_QUOTE, state: 'pending',
  });
  const section = row({ page, text: 'Should Findings say when the ice formed?' });
  return {
    heater, floods, section,
    threads: [
      { root: heater, replies: [answer(heater, 'Yes, since the autumn.')] },
      { root: section, replies: [answer(section, 'It says so in the second paragraph.')] },
      { root: floods, replies: [] },
    ],
  };
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('at 1024 pixels a chip opens its section thread in a popover over the text, and Escape gives the focus back', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ text: 'Does the pump stop every January?' });
    await serve(page, [{ root, replies: [answer(root, 'Every January since the pond was dug.')] }]);
    await load(page, COMMENTS);
    const findings = chip(page, 'findings');
    await expect(findings.chip).toHaveText('1 reply · ✓ hermes answered');
    const risks = page.locator('h2#risks');
    const before = await inPage(risks);

    await findings.chip.click();
    const pop = popover(page);
    await expect(pop.node).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Section Findings' })).toBeVisible();
    await expect(pop.title).toHaveText('Section Findings');
    await expect(pop.thread(root.id)).toBeVisible();
    await expect(pop.thread(root.id).locator('.artifact-comment-item--agent .artifact-comment-text'))
      .toHaveText('Every January since the pond was dug.');
    await expect(pop.node.getByRole('button', { name: 'Resolve' })).toBeVisible();
    await expect(pop.close).toBeVisible();
    await expect(findings.details).not.toHaveAttribute('open');

    const under = await rect(findings.chip);
    const over = await rect(pop.node);
    expect(over.top).toBeGreaterThan(under.bottom);
    expect(over.top).toBeGreaterThanOrEqual(0);
    expect(over.bottom).toBeLessThanOrEqual(MEDIUM.height);
    expect(over.left).toBeGreaterThanOrEqual(0);
    expect(over.right).toBeLessThanOrEqual(MEDIUM.width);
    // Over the text: it covers the Risks heading, which has not moved in the
    // page, though the page may scroll to leave the popover room.
    expect(await inPage(risks)).toEqual(before);
    expect(await pop.node.evaluate((node) => getComputedStyle(node).position)).toBe('absolute');
    const fit = await widths(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);

    await page.keyboard.press('Escape');
    await expect(pop.node).toBeHidden();
    await expect(findings.chip).toBeFocused();
    await expect(findings.details).not.toHaveAttribute('open');
    expect(await inPage(risks)).toEqual(before);
    await seen.clean();
  });

  test('at 1024 pixels a highlight opens its thread in a popover under it, one popover at a time', async ({ page }) => {
    const seen = await watch(page);
    const { heater, floods, threads } = passageThreads();
    await serve(page, threads);
    await load(page, PASSAGES);
    await expect(marks(page, heater.id)).toHaveCount(1);
    await expect(marks(page, floods.id)).toHaveCount(1);
    const pop = popover(page);

    await marks(page, heater.id).click();
    await expect(pop.node).toBeVisible();
    await expect(page.getByRole('dialog', { name: `Passage 1: ${HEATER}` })).toBeVisible();
    await expect(pop.thread(heater.id)).toBeVisible();
    const lit = await rect(marks(page, heater.id));
    expect((await rect(pop.node)).top).toBeGreaterThan(lit.bottom);
    await expect(marks(page, heater.id)).toHaveClass(/artifact-passage--lit/);

    await marks(page, floods.id).click();
    await expect(page.locator('.artifact-comments-popover:visible')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: `Passage 2: ${FLOODS}` })).toBeVisible();
    await expect(pop.thread(floods.id)).toBeVisible();
    await expect(pop.threads).toHaveCount(1);
    expect((await rect(pop.node)).top).toBeGreaterThan((await rect(marks(page, floods.id))).bottom);
    const fit = await widths(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);

    // A click outside closes it.
    await page.locator('h1').click();
    await expect(pop.node).toBeHidden();
    await expect(page.locator('.artifact-comments-popover:visible')).toHaveCount(0);
    await seen.clean();
  });

  test('at 1024 pixels No comments opens a composer in a popover, and so does the selection pill', async ({ page }) => {
    const seen = await watch(page);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page, COMMENTS);
    const steps = chip(page, 'next-steps');
    await expect(steps.chip).toHaveText('No comments · Comment');
    await steps.chip.click();
    const pop = popover(page);
    await expect(pop.node).toBeVisible();
    await expect(pop.title).toHaveText('Section Next steps');
    await expect(pop.field).toBeFocused();
    await page.keyboard.type('Who fits the heater?');
    await pop.send.click();
    await expect(pop.threads).toHaveCount(1);
    await expect(pop.threads.locator('.artifact-comment-item--reader .artifact-comment-text'))
      .toHaveText('Who fits the heater?');
    await expect(steps.chip).toHaveText('1 comment · waiting');
    await expect(steps.details).not.toHaveAttribute('open');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await serve(page, []);
    await load(page, PASSAGES);
    await choose(page, HEATER);
    const offered = page.locator('button.artifact-passage-pill');
    await expect(offered).toBeVisible();
    await offered.click();
    await expect(pop.node).toBeVisible();
    await expect(pop.node.locator('.artifact-passage-composer')).toBeVisible();
    await expect(pop.node.locator('.artifact-passage-quote')).toHaveText(HEATER);
    await expect(pop.node.locator('.artifact-passage-composer textarea')).toBeFocused();
    expect((await rect(pop.node)).top).toBeGreaterThan((await rect(page.locator('mark.artifact-passage--pending').last())).bottom);
    await seen.clean();
  });

  test('at 1024 pixels hermes answers in the open popover without a reload, and nothing below moves', async ({ page }) => {
    test.setTimeout(120_000);
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    const seen = await watch(page);
    // hermes pulls first, so it is listening and the comment waits for it.
    hermes('pull', '--owner', OWNER);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page, COMMENTS);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    const risks = chip(page, 'risks');
    await risks.chip.click();
    const pop = popover(page);
    await expect(pop.field).toBeFocused();
    const COMMENT = 'Will the frozen pump crack this winter?';
    await pop.field.fill(COMMENT);
    await pop.send.click();
    await expect(pop.threads).toHaveCount(1);
    const id = Number(await pop.threads.first().getAttribute('data-thread'));
    const thread = pop.thread(id);
    const below = page.locator('h2#next-steps');
    const before = await rect(below);

    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe(OWNER);
    await expect(thread.locator('.artifact-comment-typing--claimed')).toHaveCount(1, { timeout: 15_000 });
    const REPLY = 'Not with the heater running beside it.';
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `narrow-${id}`, '--text', REPLY);
    const theirs = thread.locator('.artifact-comment-item--agent');
    await expect(theirs).toHaveCount(1, { timeout: 15_000 });
    await expect(theirs.locator('.artifact-comment-text')).toHaveText(REPLY);
    await expect(pop.node).toBeVisible();
    const left = await rect(theirs.locator('.artifact-comment-text'));
    const right = await rect(thread.locator('.artifact-comment-item--reader .artifact-comment-text'));
    expect(left.left).toBeLessThan(right.left);
    expect(await rect(below)).toEqual(before);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    await seen.clean();
  });

  test('what is open moves with the window from popover to sheet to panel, its typed words kept', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ text: 'Does the pump stop every January?' });
    await serve(page, [{ root, replies: [answer(root, 'Every January.')] }]);
    await load(page, COMMENTS);
    const steps = chip(page, 'next-steps');
    await steps.chip.click();
    const pop = popover(page);
    await expect(pop.field).toBeFocused();
    await page.keyboard.type('Half a thought');

    await page.setViewportSize(PHONE);
    await expect(pop.node).toBeHidden();
    const bottom = sheet(page);
    const field = bottom.node.locator('form.artifact-comment-form textarea[name="text"]');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Half a thought');
    // One form for each box, the whole page's among them: none copied.
    await expect(page.locator('form.artifact-comment-form textarea[name="text"]')).toHaveCount(4);
    let fit = await widths(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(bottom.node).toBeHidden();
    const aside = page.locator('aside.artifact-comments-panel');
    await expect(aside).toBeVisible();
    const kept = aside.locator('form.artifact-comment-form textarea[name="text"]').filter({ visible: true });
    await expect(kept).toHaveCount(1);
    await expect(kept).toHaveValue('Half a thought');
    await expect(steps.details).not.toHaveAttribute('open');

    // From the panel the draft opens in a popover under its chip.
    await page.setViewportSize(MEDIUM);
    await expect(aside).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Section Next steps' })).toBeVisible();
    await expect(pop.field).toBeVisible();
    await expect(pop.field).toHaveValue('Half a thought');
    await expect(pop.field).toBeFocused();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`)).toHaveCount(1);
    fit = await widths(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
    await seen.clean();
  });

  test('a thread or a section draft open in the panel opens in a popover and the sheet when the window narrows', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ text: 'Does the pump stop every January?' });
    await serve(page, [{ root, replies: [answer(root, 'Every January.')] }]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await load(page, COMMENTS);
    const aside = page.locator('aside.artifact-comments-panel');
    const findings = chip(page, 'findings');
    await findings.chip.click();
    await expect(aside.locator(`.artifact-comment-thread[data-thread="${root.id}"]`)).toBeVisible();

    const pop = popover(page);
    await page.setViewportSize(MEDIUM);
    await expect(aside).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Section Findings' })).toBeVisible();
    await expect(pop.thread(root.id)).toBeVisible();
    expect((await rect(pop.node)).top).toBeGreaterThan((await rect(findings.chip)).bottom);
    const bottom = sheet(page);
    await page.setViewportSize(PHONE);
    await risen(page);
    await expect(bottom.thread(root.id)).toBeVisible();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`)).toHaveCount(1);

    // A section's form being written in the panel goes with its words.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(aside).toBeVisible();
    const steps = chip(page, 'next-steps');
    await steps.chip.click();
    const written = aside.locator('form.artifact-comment-form textarea[name="text"]').filter({ visible: true });
    await expect(written).toBeFocused();
    await page.keyboard.type('Half a thought');
    await page.setViewportSize(MEDIUM);
    await expect(aside).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Section Next steps' })).toBeVisible();
    await expect(pop.field).toBeVisible();
    await expect(pop.field).toHaveValue('Half a thought');
    await expect(pop.field).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(aside).toBeVisible();
    await page.setViewportSize(PHONE);
    await risen(page);
    const field = bottom.node.locator('form.artifact-comment-form textarea[name="text"]');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Half a thought');
    const fit = await widths(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
    await seen.clean();
  });

  test('a section popover narrowed to a phone becomes its newest thread in the sheet, and a draft keeps its form', async ({ page }) => {
    const seen = await watch(page);
    const older = row({ text: 'Does the pump stop every January?' });
    const newer = row({ text: 'Does the heater keep the outlet clear?' });
    await serve(page, [
      { root: older, replies: [answer(older, 'Every January.')] },
      { root: newer, replies: [answer(newer, 'Through every frost so far.')] },
    ]);
    await load(page, COMMENTS);
    const findings = chip(page, 'findings');
    await findings.chip.click();
    const pop = popover(page);
    await expect(pop.threads).toHaveCount(2);

    await page.setViewportSize(PHONE);
    await expect(pop.node).toBeHidden();
    const bottom = sheet(page);
    await risen(page);
    await expect(bottom.at).toHaveText('2 of 2');
    await expect(bottom.state).toHaveText('✓ Answered');
    await expect(bottom.node.locator('.artifact-comment-thread')).toHaveCount(1);
    await expect(bottom.thread(newer.id)).toBeVisible();
    await expect(bottom.back).toBeEnabled();
    await bottom.back.click();
    await expect(bottom.at).toHaveText('1 of 2');
    await expect(bottom.thread(older.id)).toBeVisible();

    // A section form being written in goes to the sheet alone, its words kept.
    await page.setViewportSize(MEDIUM);
    await findings.chip.click();
    await pop.node.getByRole('button', { name: 'Comment on this section' }).click();
    await expect(pop.field).toBeFocused();
    await page.keyboard.type('Half a thought');
    await page.setViewportSize(PHONE);
    const field = bottom.node.locator('form.artifact-comment-form textarea[name="text"]');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Half a thought');
    await expect(bottom.node.locator('.artifact-comment-thread')).toHaveCount(0);
    await seen.clean();
  });

  test('a passage draft written in the panel moves to a popover and the sheet, and back through the panel', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, []);
    await page.setViewportSize({ width: 1440, height: 900 });
    await load(page, PASSAGES);
    await choose(page, HEATER);
    const offered = page.locator('button.artifact-passage-pill');
    await expect(offered).toBeVisible();
    await offered.click();
    const aside = page.locator('aside.artifact-comments-panel');
    const drafted = page.locator('.artifact-passage-composer textarea');
    await expect(aside.locator('.artifact-passage-composer')).toBeVisible();
    await expect(drafted).toBeFocused();
    await page.keyboard.type('Half a thought');

    const pop = popover(page);
    const bottom = sheet(page);
    for (const [size, holder] of [[MEDIUM, pop.node], [PHONE, bottom.node], [MEDIUM, pop.node]] as const) {
      await page.setViewportSize(size);
      await expect(holder.locator('.artifact-passage-composer')).toBeVisible();
      await expect(holder.locator('.artifact-passage-quote')).toHaveText(HEATER);
      await expect(drafted).toHaveCount(1);
      await expect(drafted).toHaveValue('Half a thought');
      await expect(drafted).toBeFocused();
      await expect(page.locator('mark.artifact-passage--pending')).toHaveCount(1);
    }

    // To the panel and back: the draft is never left in the hidden panel.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(aside.locator('.artifact-passage-composer')).toBeVisible();
    await expect(drafted).toHaveValue('Half a thought');
    await page.setViewportSize(MEDIUM);
    await expect(aside).toBeHidden();
    await expect(pop.node.locator('.artifact-passage-composer')).toBeVisible();
    await expect(drafted).toHaveValue('Half a thought');
    await seen.clean();
  });

  test('a section form opened under its threads shows inside the popover, the popover scrolling on its own', async ({ page }) => {
    const seen = await watch(page);
    const long = 'The pump stopped when the pond froze, and stayed stopped until the thaw. '.repeat(4).trim();
    const threads = [1, 2, 3].map((n) => {
      const root = row({ text: `${n}. ${long}` });
      return { root, replies: [answer(root, long)] };
    });
    await serve(page, threads);
    await load(page, COMMENTS);
    const findings = chip(page, 'findings');
    await findings.chip.click();
    const pop = popover(page);
    await expect(pop.threads).toHaveCount(3);
    const before = await page.evaluate(() => window.scrollY);
    await pop.node.getByRole('button', { name: 'Comment on this section' }).click();
    await expect(pop.field).toBeFocused();
    const field = await rect(pop.field);
    const over = await rect(pop.node);
    expect(field.top).toBeGreaterThanOrEqual(over.top);
    expect(field.bottom).toBeLessThanOrEqual(over.bottom);
    expect(field.bottom).toBeLessThanOrEqual(MEDIUM.height);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await seen.clean();
  });

  test('a popover stays in the window when the window is resized under it', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ text: 'Does the pump stop every January?' });
    await serve(page, [{ root, replies: [answer(root, 'Every January.')] }]);
    await load(page, COMMENTS);
    const findings = chip(page, 'findings');
    await findings.chip.click();
    const pop = popover(page);
    await expect(pop.thread(root.id)).toBeVisible();

    for (const size of [{ width: 1024, height: 500 }, { width: 760, height: 420 }, MEDIUM]) {
      await page.setViewportSize(size);
      await expect(pop.node).toBeVisible();
      await expect.poll(async () => {
        const over = await rect(pop.node);
        const under = await rect(findings.chip);
        return over.top > under.bottom && over.top >= 0 && over.bottom <= size.height &&
          over.left >= 0 && over.right <= size.width;
      }).toBe(true);
    }
    const fit = await widths(page);
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
    await seen.clean();
  });

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE });

    test('at 360 pixels a highlight opens the bottom sheet, and the text keeps its width', async ({ page }) => {
      const seen = await watch(page);
      const { heater, threads } = passageThreads();
      await serve(page, threads);
      await load(page, PASSAGES);
      const paragraph = page.locator('.artifact-body p', { hasText: 'The pond pump stops' });
      const width = (await rect(paragraph)).width;
      const bottom = sheet(page);
      await expect(bottom.node).toBeHidden();

      await marks(page, heater.id).click();
      await risen(page);
      await expect(page.getByRole('dialog', { name: `Passage 1: ${HEATER}` })).toBeVisible();
      await expect(bottom.at).toHaveText('1 of 3');
      await expect(bottom.state).toHaveText('✓ Answered');
      await expect(bottom.thread(heater.id)).toBeVisible();
      expect(await bottom.node.evaluate((node) => getComputedStyle(node).position)).toBe('fixed');
      const held = await rect(bottom.node);
      expect(held.height).toBeLessThanOrEqual(444);
      expect(Math.round(held.bottom)).toBe(PHONE.height);
      const lit = await rect(marks(page, heater.id));
      expect(lit.top).toBeGreaterThanOrEqual(0);
      expect(lit.bottom).toBeLessThanOrEqual(held.top);
      expect((await rect(paragraph)).width).toBe(width);
      const fit = await widths(page);
      expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
      await seen.clean();
    });

    test('at 360 pixels the sheet steps through passage and section threads, and a chip opens it at its section', async ({ page }) => {
      const seen = await watch(page);
      const { heater, floods, section, threads } = passageThreads();
      await serve(page, threads);
      await load(page, PASSAGES);
      const bottom = sheet(page);
      await marks(page, heater.id).click();
      await risen(page);
      await expect(bottom.at).toHaveText('1 of 3');
      await expect(bottom.back).toBeDisabled();

      await bottom.forth.click();
      await expect(bottom.at).toHaveText('2 of 3');
      await expect(bottom.thread(floods.id)).toBeVisible();
      await expect(bottom.state).toHaveText(`Waiting for ${OWNER}`);
      await bottom.forth.click();
      await expect(bottom.at).toHaveText('3 of 3');
      await expect(bottom.title).toHaveText('Section Findings');
      await expect(page.getByRole('dialog', { name: 'Section Findings' })).toBeVisible();
      await expect(bottom.thread(section.id)).toBeVisible();
      await expect(bottom.forth).toBeDisabled();
      // The section's chip shows above the sheet.
      const findings = chip(page, 'findings');
      expect((await rect(findings.chip)).bottom).toBeLessThanOrEqual((await rect(bottom.node)).top);
      await bottom.back.click();
      await expect(bottom.at).toHaveText('2 of 3');
      await expect(bottom.thread(floods.id)).toBeVisible();
      await bottom.close.click();
      await expect(bottom.node).toBeHidden();
      await expect(marks(page, heater.id)).toBeFocused();

      await findings.chip.click();
      await risen(page);
      await expect(bottom.at).toHaveText('3 of 3');
      await expect(bottom.title).toHaveText('Section Findings');
      await expect(bottom.thread(section.id)).toBeVisible();
      await expect(findings.details).not.toHaveAttribute('open');
      await bottom.close.click();
      await expect(bottom.node).toBeHidden();
      await expect(findings.chip).toBeFocused();

      await findings.chip.click();
      await risen(page);
      await page.keyboard.press('Escape');
      await expect(bottom.node).toBeHidden();
      await expect(findings.chip).toBeFocused();
      await seen.clean();
    });

    test('at 360 pixels the sheet also steps to a thread on a section the page no longer has', async ({ page }) => {
      const seen = await watch(page);
      const { heater, threads } = passageThreads();
      const gone = row({
        page: PASSAGES_SLUG, section: 'old-notes', sectionTitle: 'Old notes', text: 'Where did the old notes go?',
      });
      threads.push({ root: gone, replies: [] });
      await serve(page, threads);
      await load(page, PASSAGES);
      const listed = page.locator(`.artifact-comments-changed .artifact-comment-thread[data-thread="${gone.id}"]`);
      await expect(listed).toHaveCount(1);
      const bottom = sheet(page);
      await marks(page, heater.id).click();
      await risen(page);
      await expect(bottom.at).toHaveText('1 of 4');

      for (const at of ['2 of 4', '3 of 4', '4 of 4']) {
        await bottom.forth.click();
        await expect(bottom.at).toHaveText(at);
      }
      await expect(bottom.title).toHaveText('Section Old notes');
      await expect(bottom.thread(gone.id)).toBeVisible();
      await expect(bottom.forth).toBeDisabled();
      await expect(page.locator(`.artifact-comment-thread[data-thread="${gone.id}"]`)).toHaveCount(1);
      await bottom.close.click();
      await expect(bottom.node).toBeHidden();
      await expect(listed).toHaveCount(1);
      await seen.clean();
    });

    test('at 360 pixels a reply written in the sheet is a right-hand bubble, its field in view while typed in', async ({ page, request }) => {
      const seen = await watch(page);
      const ids = new Set<number>();
      await ownThreads(page, ids);
      await page.goto(PASSAGES);
      const revision = await page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
      const posted = await request.post('/api/comments', {
        data: { page: PASSAGES_SLUG, section: 'findings', text: 'Is the heater wired?', quote: HEATER_QUOTE, revision },
      });
      expect(posted.status()).toBe(201);
      const root = await posted.json();
      ids.add(root.id);
      await load(page, PASSAGES);
      await expect(marks(page, root.id)).toHaveCount(1);

      await marks(page, root.id).click();
      await risen(page);
      const bottom = sheet(page);
      const thread = bottom.thread(root.id);
      await thread.locator('.artifact-comment-toggle').click();
      const field = thread.locator('form.artifact-comment-reply textarea[name="text"]');
      await expect(field).toBeFocused();
      await page.keyboard.type('Thanks');
      const typed = await rect(field);
      const held = await rect(bottom.node);
      expect(typed.top).toBeGreaterThanOrEqual(held.top);
      expect(typed.bottom).toBeLessThanOrEqual(held.bottom);
      expect(typed.top).toBeGreaterThanOrEqual(0);
      expect(typed.bottom).toBeLessThanOrEqual(PHONE.height);
      await thread.getByRole('button', { name: 'Send' }).click();

      const mine = thread.locator('.artifact-comment-item--reader');
      await expect(mine).toHaveCount(2);
      await expect(mine.nth(1).locator('.artifact-comment-text')).toHaveText('Thanks');
      const bubble = await rect(mine.nth(1).locator('.artifact-comment-text'));
      const list = await rect(thread.locator('.artifact-comment-list'));
      expect(bubble.right).toBeGreaterThan(list.right - 60);
      expect(bubble.left).toBeGreaterThan(list.left + 30);
      await expect(bottom.node).toBeVisible();
      await seen.clean();
    });

    test('under reduced motion the sheet does not slide', async ({ page }) => {
      const seen = await watch(page);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const { heater, threads } = passageThreads();
      await serve(page, threads);
      await load(page, PASSAGES);
      const bottom = sheet(page);
      await expect(bottom.node).toHaveCSS('transition-duration', '0s');
      await marks(page, heater.id).click();
      await expect(bottom.node).toBeVisible();
      await expect(bottom.node).toHaveCSS('transition-duration', '0s');
      expect(Math.round((await rect(bottom.node)).bottom)).toBe(PHONE.height);
      await seen.clean();
    });
  });

  test.describe('on a touch screen', () => {
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

    test('with a coarse pointer the pill sits below the selection', async ({ page }) => {
      const seen = await watch(page);
      await serve(page, []);
      await load(page, PASSAGES);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await choose(page, HEATER);
      const offered = page.locator('button.artifact-passage-pill');
      await expect(offered).toBeVisible();
      const chosen = await selectionRect(page);
      expect((await rect(offered)).top).toBeGreaterThan(chosen.bottom);
      const fit = await widths(page);
      expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
      await seen.clean();
    });
  });

  test('with a fine pointer at 1024 pixels the pill sits above the selection', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, []);
    await load(page, PASSAGES);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    await choose(page, HEATER);
    const offered = page.locator('button.artifact-passage-pill');
    await expect(offered).toBeVisible();
    const chosen = await selectionRect(page);
    expect((await rect(offered)).bottom).toBeLessThan(chosen.top);
    await seen.clean();
  });
});
