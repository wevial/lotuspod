import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Comments on passages: the capture fixture's passages page, words selected
// in it, the Comment pill, the composer, and each thread's words drawn as a
// numbered highlight, found again on a new revision or kept with its quote
// struck through. Checks that post go to the site, and as the run shares one
// database they show only the threads they made, found by id; others answer
// the threads route themselves. hermes publishes the page again and replies
// through real `lotuspod` commands.
const PAGE = '/capture-passages.html';
const SLUG = 'capture-passages';
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const TOKENS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'lotuspod', '_theme', 'tokens.json'), 'utf-8'));
// The reader as a page names them: their address's part before the @.
const READER = 'maintainer';
const OWNER = 'hermes';
const OPEN = { resolved: false, actor: null, at: null };
const WIDE = { width: 1440, height: 900 };

const HEATER = 'heater on the north wall';
const HEATER_QUOTE = {
  exact: HEATER,
  prefix: 'ops when the water freezes. The ',
  suffix: ' keeps the outlet clear, and the',
};
const SENTENCE = 'The heater on the north wall keeps the outlet clear, and the pump stops again only in a hard frost.';
const FINDINGS = `The pond pump stops when the water freezes. ${SENTENCE}`;
const STALE = 'This page has changed since it loaded. Reload it to comment on this passage.';
// The Risks item whose words "the bed" a check makes a link to the article
// page, as the page's markdown has no links.
const BED = 'the bed';
const BED_QUOTE = { exact: BED, prefix: 'A cracked pump floods ', suffix: ' below it.' };
const FLOODS_ITEM = '<li>A cracked pump floods the bed below it.</li>';

test.use({ viewport: WIDE });

type Violation = { blockedURI: string; effectiveDirective: string };

// Errors, policy violations and how many reads are in flight. A status a
// check makes the route answer with is logged by the browser itself, as
// the network's line; only that line is not an error.
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

// The page's source as the fixture published it.
function original() {
  return fs.readFileSync(path.join(path.dirname(OUT), `${SLUG}.md`), 'utf-8');
}

// hermes publishes source as the page, expecting it at revision.
function publish(source: string, revision: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-passages-'));
  try {
    const file = path.join(dir, `${SLUG}.md`);
    fs.writeFileSync(file, source, 'utf-8');
    run(['publish', file, '--local', '--out-dir', OUT, '--owner', OWNER, '--credential', HERMES,
      '--expect-revision', revision]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function revisionOf(page: Page) {
  return page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    aside,
    opener: aside.getByRole('button', { name: 'Comments', exact: true }),
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    group: (title: string) => aside.locator('.artifact-comments-group')
      .filter({ has: page.locator('.artifact-comments-group-title', { hasText: title }) }),
  };
}

function entry(page: Page, id: number) {
  const item = page.locator(`.artifact-comments-entry[data-thread="${id}"]`);
  return {
    item,
    head: item.locator('.artifact-comments-entry-head'),
    mark: item.locator('.artifact-comments-entry-head .artifact-comments-entry-mark'),
    words: item.locator('.artifact-comments-entry-head .artifact-comments-entry-words'),
    done: item.locator('.artifact-comments-entry-done'),
    resolve: item.getByRole('button', { name: 'Resolve' }),
    reopen: item.getByRole('button', { name: 'Reopen' }),
    readers: item.locator('.artifact-comment-item--reader'),
    agents: item.locator('.artifact-comment-item--agent'),
  };
}

function marks(page: Page, id: number) {
  return page.locator(`.artifact-body mark.artifact-passage[data-thread="${id}"]`);
}

function joined(target: Locator) {
  return target.evaluateAll((nodes) => nodes.map((node) => node.textContent).join(''));
}

const pill = (page: Page) => page.locator('button.artifact-passage-pill');
const composer = (page: Page) => page.locator('.artifact-passage-composer');
const pending = (page: Page) => page.locator('mark.artifact-passage--pending');

let next = 1;

function row(fields: Record<string, unknown>) {
  const id = 900_000 + next++;
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
    state: 'answered',
    ...fields,
  };
}

// Answer every read of the threads route with threads.
async function serve(page: Page, threads: unknown[]) {
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: SLUG, threads } }));
}

// Serve the page with the Risks item's words "the bed" a link to the
// article page.
async function linkBed(page: Page) {
  await page.route((url) => url.pathname === PAGE, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain(FLOODS_ITEM);
    await route.fulfill({
      response,
      body: body.replace(FLOODS_ITEM, '<li>A cracked pump floods <a href="capture-article.html">the bed</a> below it.</li>'),
    });
  });
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

// A thread on the heater's words, posted as the reader at revision.
async function postHeater(request: APIRequestContext, revision: string, text = 'Is this still true?') {
  const response = await request.post('/api/comments', {
    data: { page: SLUG, section: 'findings', text, quote: HEATER_QUOTE, revision },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

async function load(page: Page) {
  await page.goto(PAGE);
  await expect(page.locator('.artifact-body details.artifact-comment')).toHaveCount(3);
  await settle(page);
}

// Select words of the body's text with the mouse: from the left of the
// first character to the right of the last.
async function drag(page: Page, words: string) {
  const spots = await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector('.artifact-body')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(wanted);
      if (at < 0 || node.parentElement!.closest('details, form')) continue;
      node.parentElement!.scrollIntoView({ block: 'center' });
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
  await page.mouse.move(spots!.to.x, spots!.to.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe(words);
}

// Select through the Selection API, as the keyboard would: from the text
// node holding from (at that offset) to the one holding to (after it).
async function choose(page: Page, scope: string, from: string, to: string, length?: number) {
  const chosen = await page.evaluate(([where, start, end, size]) => {
    const texts: Text[] = [];
    document.querySelectorAll(where as string).forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    });
    const first = texts.find((node) => node.data.includes(start as string));
    if (!first) return null;
    const at = first.data.indexOf(start as string);
    if (size) {
      document.getSelection()!.setBaseAndExtent(first, at, first, at + (size as number));
    } else {
      const last = [...texts].reverse().find((node) => node.data.includes(end as string))!;
      document.getSelection()!.setBaseAndExtent(first, at, last, last.data.indexOf(end as string) + (end as string).length);
    }
    return String(document.getSelection());
  }, [scope, from, to, length ?? 0] as const);
  expect(chosen, `${scope} holds ${from}`).toBeTruthy();
  return chosen!;
}

function rgba(value: string) {
  return (/rgba?\(([^)]*)\)/.exec(value)?.[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('words selected with the mouse show the pill, and its composer posts the quote with its context', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page);
    const revision = await revisionOf(page);
    expect(revision).toBeTruthy();
    await drag(page, HEATER);
    const offer = pill(page);
    await expect(offer).toBeVisible();
    await expect(offer).toHaveText('Comment');
    await expect(offer).toHaveAttribute('aria-keyshortcuts', 'Control+Alt+M');
    await expect(offer).not.toBeFocused();
    const line = await page.evaluate(() => {
      const rects = document.getSelection()!.getRangeAt(0).getClientRects();
      const last = rects[rects.length - 1];
      return { top: last.top, right: last.right };
    });
    const box = (await offer.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(line.top);
    expect(line.top - (box.y + box.height)).toBeLessThanOrEqual(40);
    const column = (await page.locator('.artifact-body').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(column.x);
    expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width);

    await offer.click();
    const side = panel(page);
    await expect(side.fold).toBeVisible();
    const open = side.group('Findings').locator('.artifact-passage-composer');
    await expect(open).toBeVisible();
    await expect(open.locator('.artifact-passage-quote')).toHaveText(HEATER);
    const field = open.locator('textarea[name="text"]');
    await expect(field).toBeFocused();
    expect(await joined(pending(page))).toBe(HEATER);
    await expect(offer).toBeHidden();

    await field.fill('Is this still true?');
    const sent = page.waitForRequest((request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/comments');
    await open.getByRole('button', { name: 'Comment', exact: true }).click();
    const body = (await sent).postDataJSON();
    expect(body).toEqual({
      page: SLUG,
      section: 'findings',
      text: 'Is this still true?',
      quote: HEATER_QUOTE,
      revision,
    });
    await expect.poll(() => ids.size).toBe(1);
    await expect(composer(page)).toHaveCount(0);
    await expect(pending(page)).toHaveCount(0);
    await seen.clean();
  });

  test('a passage thread is a numbered highlight in the tokens colours, listed as 1 under its section', async ({ page }) => {
    const seen = await watch(page);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await load(page);
    await drag(page, HEATER);
    await pill(page).click();
    const field = panel(page).group('Findings').locator('.artifact-passage-composer textarea');
    await field.fill('Is this still true?');
    await panel(page).group('Findings').locator('.artifact-passage-composer')
      .getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => ids.size).toBe(1);
    const [id] = [...ids];
    // Its entry opens, which lights its words: fold it, and move the pointer
    // away from the words, so they are at rest.
    await expect(entry(page, id).head).toHaveAttribute('aria-expanded', 'true');
    await entry(page, id).head.click();
    await expect(entry(page, id).head).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(5, 5);

    const check = async () => {
      const side = panel(page);
      const listed = side.group('Findings').locator('.artifact-comments-entry');
      await expect(listed).toHaveCount(1);
      await expect(entry(page, id).mark).toHaveText('1');
      await expect(entry(page, id).words).toHaveText(HEATER);
      const drawn = marks(page, id);
      await expect(drawn.first()).toBeVisible();
      expect(await joined(drawn)).toBe(HEATER);
      const colours = await drawn.evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, line: style.borderBottomColor, width: style.borderBottomWidth };
      }));
      for (const colour of colours) {
        expect(rgba(colour.background)).toEqual(rgba(TOKENS.structure.highlight));
        expect(rgba(colour.line)).toEqual(rgba(TOKENS.structure.highlight_line));
        expect(parseFloat(colour.width)).toBeGreaterThan(0);
      }
      const number = await drawn.last().evaluate((node) => {
        const after = node.nextElementSibling;
        return after && after.classList.contains('artifact-passage-number')
          ? { tag: after.localName, text: after.textContent, label: after.getAttribute('aria-label') } : null;
      });
      expect(number).toEqual({ tag: 'button', text: '1', label: 'Open comment 1' });
      for (const described of await drawn.evaluateAll((nodes) => nodes.map((node) => {
        const named = document.getElementById(node.getAttribute('aria-describedby') ?? '');
        return named ? { text: named.textContent, thread: named.closest('[data-thread]')?.getAttribute('data-thread') } : null;
      }))) {
        expect(described).toEqual({ text: 'Is this still true?', thread: String(id) });
      }
    };
    await check();

    await page.reload();
    await settle(page);
    await page.mouse.move(5, 5);
    await check();

    // A mark opens the panel at its thread; pointing at the entry lights the words.
    const side = panel(page);
    if (await side.fold.isVisible()) await side.fold.click();
    await expect(side.opener).toBeVisible();
    await marks(page, id).first().click();
    await expect(side.fold).toBeVisible();
    await expect(entry(page, id).head).toHaveAttribute('aria-expanded', 'true');
    await expect(entry(page, id).readers.locator('.artifact-comment-text')).toHaveText('Is this still true?');
    await expect(marks(page, id).first()).toHaveClass(/artifact-passage--lit/);
    await entry(page, id).head.click();
    await expect(entry(page, id).head).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(5, 5);
    await expect(marks(page, id).first()).not.toHaveClass(/artifact-passage--lit/);
    await entry(page, id).item.hover();
    await expect(marks(page, id).first()).toHaveClass(/artifact-passage--lit/);
    const lit = await marks(page, id).first().evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(rgba(lit)).not.toEqual(rgba(TOKENS.structure.highlight));
    await page.mouse.move(5, 5);
    await expect(marks(page, id).first()).not.toHaveClass(/artifact-passage--lit/);
    await seen.clean();
  });

  test('a passage number is a button named for its thread, and on plain words it and the highlight open it', async ({ page }) => {
    const seen = await watch(page);
    const heater = row({ text: 'Which heater is it?', quote: HEATER_QUOTE });
    const bed = row({ section: 'risks', sectionTitle: 'Risks', text: 'How far does it flood?', quote: BED_QUOTE });
    await serve(page, [{ root: heater, replies: [], resolution: OPEN }, { root: bed, replies: [], resolution: OPEN }]);
    await linkBed(page);
    await load(page);
    const first = page.getByRole('button', { name: 'Open comment 1', exact: true });
    const second = page.getByRole('button', { name: 'Open comment 2', exact: true });
    await expect(first).toHaveAttribute('data-thread', String(heater.id));
    await expect(first).toHaveText('1');
    await expect(first).not.toHaveAttribute('aria-hidden');
    await expect(second).toHaveAttribute('data-thread', String(bed.id));
    await expect(second).toHaveText('2');

    const side = panel(page);
    const mine = entry(page, heater.id);
    await marks(page, heater.id).first().click();
    await expect(side.fold).toBeVisible();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.head).toBeFocused();
    await mine.head.click();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'false');

    await first.click();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.head).toBeFocused();
    await expect(mine.readers.locator('.artifact-comment-text')).toHaveText('Which heater is it?');
    await seen.clean();
  });

  test('a passage on a link opens from its number, outside the link, by click, Enter and Space, and the link still follows', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ section: 'risks', sectionTitle: 'Risks', text: 'How far does it flood?', quote: BED_QUOTE });
    await serve(page, [{ root, replies: [], resolution: OPEN }]);
    await linkBed(page);
    await load(page);
    const link = page.locator('.artifact-body a', { hasText: BED });
    const drawn = marks(page, root.id);
    await expect(drawn).toHaveCount(1);
    expect(await joined(drawn)).toBe(BED);
    expect(await drawn.evaluate((node) => node.closest('a')?.getAttribute('href'))).toBe('capture-article.html');
    const number = page.getByRole('button', { name: 'Open comment 1', exact: true });
    await expect(number).toHaveAttribute('data-thread', String(root.id));
    const placed = await number.evaluate((node) => ({
      inLink: node.closest('a') !== null,
      before: node.previousElementSibling?.localName,
      beforeText: node.previousElementSibling?.textContent,
    }));
    expect(placed).toEqual({ inLink: false, before: 'a', beforeText: BED });

    // A click on the number opens the thread and stays on the page.
    const side = panel(page);
    const mine = entry(page, root.id);
    const url = page.url();
    await number.click();
    await expect(side.fold).toBeVisible();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.head).toBeFocused();
    await expect(mine.readers.locator('.artifact-comment-text')).toHaveText('How far does it flood?');
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);

    // From the link, Tab reaches the number, and Enter or Space opens it,
    // with nothing selected or with the link's words selected.
    const selectBed = async () => {
      await choose(page, '.artifact-body li', BED, BED);
      expect(await page.evaluate(() => String(document.getSelection()))).toBe(BED);
    };
    for (const key of ['Enter', 'Space']) {
      for (const selecting of [false, true]) {
        const name = `${key}${selecting ? ' with the words selected' : ''}`;
        await page.evaluate(() => document.getSelection()!.removeAllRanges());
        await mine.head.click();
        await expect(mine.head).toHaveAttribute('aria-expanded', 'false');
        await link.focus();
        if (selecting) await selectBed();
        await page.keyboard.press('Tab');
        await expect(number, name).toBeFocused();
        await page.keyboard.press(key);
        await expect(mine.head, name).toHaveAttribute('aria-expanded', 'true');
        await expect(mine.head, name).toBeFocused();
        expect(page.url(), name).toBe(url);
      }
    }

    // With the link's words selected, a click on the number opens it too.
    await mine.head.click();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'false');
    await selectBed();
    await number.click();
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    await expect(mine.head).toBeFocused();
    expect(page.url()).toBe(url);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());

    // A click on the highlighted words follows the link.
    await drawn.click();
    await expect(page).toHaveURL(/\/capture-article\.html$/);
    await seen.clean();
  });

  test('no pill for words in the panel, a decision form, the header, two sections or over 500 characters', async ({ page }) => {
    const seen = await watch(page);
    const root = row({ text: 'Which heater is it?', quote: HEATER_QUOTE });
    await serve(page, [{ root, replies: [], resolution: OPEN }]);
    await load(page);
    const side = panel(page);
    await side.opener.click();
    await entry(page, root.id).head.click();
    await expect(entry(page, root.id).readers).toHaveCount(1);
    const offer = pill(page);

    // A selection that may have one shows it.
    await choose(page, '.artifact-body p', 'pump stops when', 'pump stops when');
    await expect(offer).toBeVisible();

    const cases: [string, () => Promise<string>][] = [
      ['a bubble in the panel', () => choose(page, '.artifact-comments-panel .artifact-comment-text', 'Which heater', 'is it?')],
      ['the decision form', () => choose(page, 'form.artifact-decision .artifact-decision-label', 'Submerged', 'Submerged')],
      ['the page title', () => choose(page, 'header .artifact-title', 'Capture', 'passages')],
      ['two sections', () => choose(page, '.artifact-body :is(p, li)', 'The pond pump', 'notices.')],
      ['501 characters', () => choose(page, '.artifact-body p', 'Through the winter', '', 501)],
    ];
    for (const [name, make] of cases) {
      await page.evaluate(() => document.getSelection()!.removeAllRanges());
      const words = await make();
      expect(words.length, name).toBeGreaterThan(0);
      if (name === '501 characters') expect(Array.from(words).length).toBe(501);
      await page.waitForTimeout(500);
      await expect(offer, name).toBeHidden();
    }
    // Just under the limit, the same paragraph offers it.
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await choose(page, '.artifact-body p', 'Through the winter', '', 500);
    await expect(offer).toBeVisible();
    await seen.clean();
  });

  test('a keyboard selection opens the composer with Control Alt M, and Escape posts nothing', async ({ page }) => {
    const seen = await watch(page);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    const posts: string[] = [];
    // Every post but the page's own of the revision it was opened at.
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname !== '/api/seen') {
        posts.push(request.url());
      }
    });
    await load(page);
    await choose(page, '.artifact-body p', 'pump stops when', 'pump stops when');
    await expect(pill(page)).toBeVisible();
    await page.keyboard.press('Control+Alt+KeyM');
    const open = composer(page);
    await expect(open).toBeVisible();
    await expect(open.locator('.artifact-passage-quote')).toHaveText('pump stops when');
    await expect(open.locator('textarea')).toBeFocused();
    expect(await joined(pending(page))).toBe('pump stops when');
    await open.locator('textarea').fill('Does it?');
    await page.keyboard.press('Escape');
    await expect(composer(page)).toHaveCount(0);
    await expect(page.locator('mark.artifact-passage')).toHaveCount(0);
    await expect(page.locator('.artifact-body p', { hasText: 'The pond pump' })).toHaveText(FINDINGS);
    // Escape in the composer leaves the panel as it was.
    await expect(panel(page).fold).toBeVisible();
    await page.waitForTimeout(300);
    expect(posts).toEqual([]);
    expect(ids.size).toBe(0);
    await seen.clean();
  });

  test('a page changed since it loaded keeps the composer and its text and says to reload', async ({ page }) => {
    const seen = await watch(page, ['409 (Conflict)']);
    const ids = new Set<number>();
    await ownThreads(page, ids);
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 409, json: { error: 'stale_page' } });
      } else {
        await route.fallback();
      }
    });
    await load(page);
    await choose(page, '.artifact-body p', 'pump stops when', 'pump stops when');
    await expect(pill(page)).toBeVisible();
    await page.keyboard.press('Control+Alt+KeyM');
    const open = composer(page);
    const field = open.locator('textarea');
    await field.fill('Is it the same pump?');
    await open.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(open.locator('.artifact-comment-status')).toHaveText(STALE);
    await expect(field).toHaveValue('Is it the same pump?');
    expect(await joined(pending(page))).toBe('pump stops when');
    await seen.clean();
  });

  test('a passage is found again on a new revision, and between its context where its words occur twice', async ({ page, request }) => {
    test.setTimeout(120_000);
    const seen = await watch(page);
    await load(page);
    const before = (await revisionOf(page))!;
    const asked = await postHeater(request, before, 'Still on the north wall?');
    const ids = new Set<number>([asked.id]);
    await ownThreads(page, ids);
    const source = original();
    const changed = source.replace(`## Findings\n\n${FINDINGS}`, [
      '## Findings',
      '',
      'The pond was dug in the spring of 2019 and holds about four thousand litres.',
      '',
      'The pond pump stops when the water freezes. The heater',
      'on the north wall keeps the outlet clear, and the pump stops',
      'again only in a hard frost.',
    ].join('\n'));
    expect(changed).not.toBe(source);
    publish(changed, before);
    try {
      await page.reload();
      await settle(page);
      const after = await revisionOf(page);
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
      await expect(marks(page, asked.id).first()).toBeVisible();
      expect(await joined(marks(page, asked.id))).toBe(HEATER);
      await expect(entry(page, asked.id).mark).toHaveText('1');

      // Only its spacing changed: a no-break space and a thin space are
      // whitespace as much as a space is.
      const spaced = source.replace(HEATER, 'heater on the\u00a0north\u2009wall');
      expect(spaced).not.toBe(source);
      publish(spaced, after!);
      await page.reload();
      await settle(page);
      expect(await revisionOf(page)).not.toBe(after);
      await expect(marks(page, asked.id).first()).toBeVisible();
      expect(await joined(marks(page, asked.id))).toBe('heater on the\u00a0north\u2009wall');
      await expect(entry(page, asked.id).words.locator('del')).toHaveCount(0);
      await expect(entry(page, asked.id).mark).toHaveText('1');
    } finally {
      publish(source, (await revisionOf(page))!);
    }

    // Two occurrences: the one between its context.
    await page.unrouteAll({ behavior: 'wait' });
    const root = row({ text: 'Again?', quote: { exact: 'pump stops', prefix: 'and the ', suffix: ' again' } });
    await serve(page, [{ root, replies: [], resolution: OPEN }]);
    await page.reload();
    await settle(page);
    await expect(page.locator('meta[name="lotuspod:revision"]')).toHaveAttribute('content', before);
    const drawn = marks(page, root.id);
    await expect(drawn).toHaveCount(1);
    expect(await joined(drawn)).toBe('pump stops');
    const around = await drawn.evaluate((node) => {
      const before = node.previousSibling?.textContent ?? '';
      const after = node.nextSibling?.nextSibling?.textContent ?? '';
      return { before: before.slice(-8), after: after.slice(0, 6) };
    });
    expect(around).toEqual({ before: 'and the ', after: ' again' });
    await seen.clean();
  });

  test('a passage deleted from the page keeps its thread with the quote struck through', async ({ page, request }) => {
    test.setTimeout(120_000);
    const seen = await watch(page);
    await load(page);
    const before = (await revisionOf(page))!;
    const asked = await postHeater(request, before, 'Is the heater still there?');
    const ids = new Set<number>([asked.id]);
    await ownThreads(page, ids);
    const source = original();
    const changed = source.replace(` ${SENTENCE}`, '');
    expect(changed).not.toBe(source);
    publish(changed, before);
    try {
      await page.reload();
      await settle(page);
      const after = (await revisionOf(page))!;
      expect(after).not.toBe(before);
      await expect(page.locator('.artifact-body')).not.toContainText('north wall');
      await expect(marks(page, asked.id)).toHaveCount(0);
      await expect(page.locator(`.artifact-passage-number[data-thread="${asked.id}"]`)).toHaveCount(0);
      const side = panel(page);
      if (await side.opener.isVisible()) await side.opener.click();
      const lost = entry(page, asked.id);
      await expect(side.group('Findings').locator(`.artifact-comments-entry[data-thread="${asked.id}"]`)).toHaveCount(1);
      await expect(lost.words.locator('del')).toHaveText(HEATER);
      await expect(lost.words).toContainText('this passage has changed since');
      await expect(lost.words).not.toContainText(after);
      await expect(lost.words.locator('.artifact-passage-why')).toHaveAttribute('title', `Changed in revision ${after}`);
      await expect(lost.mark).toHaveText('1');
      await lost.head.click();
      await expect(lost.readers.locator('.artifact-comment-text')).toHaveText('Is the heater still there?');
      await expect(lost.item.getByRole('button', { name: 'Add to your comment' })).toBeVisible();
    } finally {
      publish(source, (await revisionOf(page))!);
    }

    // Neither occurrence lies between its context, and there are two.
    await page.unrouteAll({ behavior: 'wait' });
    const root = row({ text: 'At dawn?', quote: { exact: 'pump stops', prefix: 'the old ', suffix: ' at dawn' } });
    await serve(page, [{ root, replies: [], resolution: OPEN }]);
    await page.reload();
    await settle(page);
    await expect(page.locator('mark.artifact-passage')).toHaveCount(0);
    const side = panel(page);
    if (await side.opener.isVisible()) await side.opener.click();
    const lost = entry(page, root.id);
    await expect(lost.words.locator('del')).toHaveText('pump stops');
    await expect(lost.words).toContainText('this passage has changed since');
    await expect(lost.words).not.toContainText(before);
    await expect(lost.words.locator('.artifact-passage-why')).toHaveAttribute('title', `Changed in revision ${before}`);
    await seen.clean();
  });

  test('a reply from hermes lands in the passage thread in the panel and the paragraph stays still', async ({ page }) => {
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
    await drag(page, HEATER);
    await pill(page).click();
    const open = panel(page).group('Findings').locator('.artifact-passage-composer');
    await open.locator('textarea').fill('Which side of the pump is the heater?');
    await open.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => ids.size).toBe(1);
    const [id] = [...ids];
    const mine = entry(page, id);
    await expect(mine.head).toHaveAttribute('aria-expanded', 'true');
    const paragraph = page.locator('.artifact-body p', { hasText: 'The pond pump stops' });
    const spot = async () => {
      const box = (await paragraph.boundingBox())!;
      return { x: box.x, y: box.y, height: box.height };
    };
    const before = await spot();

    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe(OWNER);
    const REPLY = 'The heater sits on the north side, away from the pump.';
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `passage-${id}`, '--text', REPLY);
    await expect(mine.agents).toHaveCount(1, { timeout: 15_000 });
    const theirs = mine.agents.first();
    await expect(theirs.locator('.artifact-comment-text')).toHaveText(REPLY);
    const left = (await theirs.locator('.artifact-comment-avatar').boundingBox())!;
    const right = (await mine.readers.first().locator('.artifact-comment-avatar').boundingBox())!;
    expect(left.x).toBeLessThan(right.x);
    expect(await spot()).toEqual(before);
    expect(await joined(marks(page, id))).toBe(HEATER);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    await seen.clean();
  });

  test('a resolved passage loses its highlight until reopened, and a narrow window opens it in a popover', async ({ page, request }) => {
    const seen = await watch(page);
    await load(page);
    const asked = await postHeater(request, (await revisionOf(page))!, 'Should the heater move?');
    const ids = new Set<number>([asked.id]);
    await ownThreads(page, ids);
    await page.reload();
    await settle(page);
    const side = panel(page);
    const thread = entry(page, asked.id);
    await expect(marks(page, asked.id).first()).toBeVisible();
    await marks(page, asked.id).first().click();
    await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
    await thread.resolve.click();
    await expect(thread.done).toHaveText('✓ resolved · Reopen');
    await expect(marks(page, asked.id)).toHaveCount(0);
    await expect(page.locator(`.artifact-passage-number[data-thread="${asked.id}"]`)).toHaveCount(0);
    await expect(page.locator('.artifact-body p', { hasText: 'The pond pump' })).toHaveText(FINDINGS);
    await expect(thread.item).toBeHidden();
    await side.aside.getByRole('button', { name: 'Show resolved (1)' }).click();
    await thread.reopen.click();
    await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
    expect(await joined(marks(page, asked.id))).toBe(HEATER);
    await expect(page.locator(`.artifact-passage-number[data-thread="${asked.id}"]`)).toHaveText('1');
    await expect(side.fold).toBeVisible();

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.reload();
    await settle(page);
    await expect(side.aside).toBeHidden();
    const findings = page.locator('details.artifact-comment[data-section="findings"]');
    const popover = page.locator('.artifact-comments-popover');
    const held = popover.locator(`.artifact-comment-thread[data-thread="${asked.id}"]`);
    await expect(findings).not.toHaveAttribute('open');
    await marks(page, asked.id).first().click();
    await expect(findings).not.toHaveAttribute('open');
    await expect(held).toBeVisible();
    await expect(popover.locator('.artifact-comments-held-title')).toHaveText(`1 ${HEATER}`);
    await expect(held.locator('.artifact-comment-text')).toHaveText('Should the heater move?');
    await seen.clean();
  });

  test('no width scrolls sideways with a composer open at 360 pixels or the panel open at 1440', async ({ page }) => {
    const seen = await watch(page);
    await serve(page, []);
    const fits = () => page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    }));
    await page.setViewportSize({ width: 360, height: 780 });
    await load(page);
    await choose(page, '.artifact-body p', 'The heater', 'hard frost.');
    await expect(pill(page)).toBeVisible();
    const offer = (await pill(page).boundingBox())!;
    expect(offer.x).toBeGreaterThanOrEqual(0);
    expect(offer.x + offer.width).toBeLessThanOrEqual(360);
    await pill(page).click();
    const open = page.locator('.artifact-comments-bottom-sheet .artifact-passage-composer');
    await expect(open).toBeVisible();
    await expect(open.locator('textarea')).toBeFocused();
    let widths = await fits();
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);

    await page.setViewportSize(WIDE);
    await expect(panel(page).fold).toBeVisible();
    await expect(panel(page).group('Findings').locator('.artifact-passage-composer')).toBeVisible();
    widths = await fits();
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
    await seen.clean();
  });
});
