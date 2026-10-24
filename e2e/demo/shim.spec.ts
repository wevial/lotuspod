import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// The demo site's shim (demo/shim.js, served as lotuspod-demo.js) in a real
// Chromium at 1280 px: comments, passage comments, replies, resolutions and
// decision answers kept in the visitor's localStorage, demo-agent's scripted
// replies, image uploads refused, and "Reset demo". `python -m demo.build
// --serve -- CMD` serves the site and names its request log in
// LOTUSPOD_DEMO_LOG; the last check reads it for any /api/ request.
const TRY_IT = '/try-it.html';
const OPERATING = '/operating.html';
const AGENT = 'demo-agent';
const READER = 'you';
const MODEL = 'scripted';
const KEY = 'lotuspod-demo:';
const REPLIES = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'demo', 'replies.json'), 'utf-8'));
const NO_UPLOADS = 'image uploading is disabled for the demo';
// A 1 by 1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

// Every request the browser sends to /api/, which must stay none, and every
// error the page throws.
function watch(context: BrowserContext, page: Page) {
  const api: string[] = [];
  const errors: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return {
    errors,
    clean: () => {
      expect(api, 'no request reaches /api/').toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}

// Load a page and wait for its first read of threads: every chip drawn.
async function load(page: Page, url: string) {
  await page.goto(`${url}?standalone`);
  await settle(page);
}

async function settle(page: Page) {
  const boxes = page.locator('details.artifact-comment');
  await expect(boxes.first()).toBeAttached();
  const count = await boxes.count();
  await expect(page.locator('details.artifact-comment > summary.artifact-comment-chip')).toHaveCount(count);
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    aside,
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    showResolved: aside.getByRole('button', { name: /^Show resolved/ }),
    entries: aside.locator('.artifact-comments-entry'),
    group: (title: string) => aside.locator('.artifact-comments-group')
      .filter({ has: page.locator('.artifact-comments-group-title', { hasText: title }) }),
  };
}

function entry(page: Page, id: number) {
  const item = page.locator(`.artifact-comments-entry[data-thread="${id}"]`);
  return {
    item,
    head: item.locator('.artifact-comments-entry-head'),
    done: item.locator('.artifact-comments-entry-done'),
    resolve: item.getByRole('button', { name: 'Resolve' }),
    reopen: item.getByRole('button', { name: 'Reopen' }),
    readers: item.locator('.artifact-comment-item--reader'),
    agents: item.locator('.artifact-comment-item--agent'),
    waiting: item.locator('.artifact-comment-typing--pending'),
  };
}

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    option: (name: string) => form.getByRole('radio', { name }),
    save: form.getByRole('button', { name: 'Save answer' }),
    saved: form.locator('.artifact-decision-saved-line'),
    change: form.getByRole('button', { name: 'change' }),
    history: form.locator('.artifact-decision-history'),
    hint: form.locator('.artifact-decision-hint'),
    addNote: form.locator('details.artifact-decision-note > summary'),
    note: form.locator('textarea[name="note"]'),
    ask: form.getByRole('button', { name: 'Ask', exact: true }),
    chip: page.locator(`form.artifact-decision[data-question="${question}"] + .artifact-decision-chip`),
  };
}

// The rows the shim keeps for a page, oldest first.
async function rows(page: Page, name: string): Promise<any[]> {
  return page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    return stored ? stored.rows : [];
  }, `${KEY}threads:${name}`);
}

async function demoKeys(page: Page) {
  return page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), KEY);
}

// The newest thread's first comment the shim keeps for a page.
async function newestRoot(page: Page, name: string) {
  const found = (await rows(page, name)).filter((row) => row.parent === null);
  expect(found.length).toBeGreaterThan(0);
  return found[found.length - 1];
}

// Open a section's threads in the panel through its chip; its new-thread form.
async function openSection(page: Page, section: string, title: string) {
  await page.locator(`details.artifact-comment[data-section="${section}"] > summary`).click();
  const group = panel(page).group(title);
  await expect(group).toBeVisible();
  return group;
}

// Comment on a section through its chip; the new thread's first comment.
async function comment(page: Page, name: string, section: string, title: string, words: string) {
  const group = await openSection(page, section, title);
  const start = group.getByRole('button', { name: 'Comment on this section' });
  if (await start.isVisible()) await start.click();
  const field = group.locator('form.artifact-comment-form textarea[name="text"]');
  await expect(field).toBeVisible();
  await field.fill(words);
  await group.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(field).toHaveValue('');
  return newestRoot(page, name);
}

async function expectReply(thread: ReturnType<typeof entry>, words: string, count = 1) {
  await expect(thread.agents).toHaveCount(count, { timeout: 15_000 });
  const reply = thread.agents.nth(count - 1);
  await expect(reply.locator('.artifact-comment-handle')).toHaveText(AGENT);
  await expect(reply.locator('.artifact-comment-model')).toHaveText(MODEL);
  await expect(reply.locator('.artifact-comment-text')).toHaveText(words);
}

// One request through the page's fetch, which the shim answers: its status
// and JSON.
async function api(page: Page, method: string, url: string, body?: object) {
  return page.evaluate(async ({ method, url, body }) => {
    const response = await fetch(url, body === undefined ? { method } : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }, { method, url, body });
}

// The thread whose first comment is root, as the shim's read of try-it's
// threads gives it.
async function thread(page: Page, root: number) {
  const read = await api(page, 'GET', '/api/comments?page=try-it');
  expect(read.status).toBe(200);
  return read.json.threads.find((each: any) => each.root.id === root);
}

// Select words of the body's text with the mouse.
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
  await page.mouse.move(spots!.to.x, spots!.to.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe(words);
}

test('a section comment waits for demo-agent, then gets the canned reply for its section', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const words = 'Should the lilies go in before the marginals?';
  const root = await comment(page, 'try-it', 'the-pond-today', 'The pond today', words);
  expect(root).toMatchObject({ section: 'the-pond-today', actor: { kind: 'human', name: READER }, state: 'pending' });
  const thread = entry(page, root.id);
  await expect(thread.readers.locator('.artifact-comment-text')).toHaveText(words);
  await expect(thread.readers.locator('.artifact-comment-author')).toHaveText(READER);
  await expect(thread.waiting).toContainText(AGENT);
  await expectReply(thread, REPLIES['try-it']['the-pond-today']);
  await expect(thread.waiting).toHaveCount(0);
  seen.clean();
});

test('a comment on a section replies.json does not name gets the generic reply', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, OPERATING);
  expect(REPLIES.operating?.backups).toBeUndefined();
  const root = await comment(page, 'operating', 'backups', 'Backups', 'How often do the backups run?');
  const thread = entry(page, root.id);
  await expect(thread.waiting).toContainText(AGENT);
  await expectReply(thread, REPLIES['*']);
  seen.clean();
});

test('a comment on the whole page from the chip under the title gets the generic reply', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const root = await comment(page, 'try-it', '', 'This page', 'Is this plan still current?');
  expect(root).toMatchObject({ section: '', sectionTitle: '', quote: null, state: 'pending' });
  const thread = entry(page, root.id);
  await expect(thread.waiting).toContainText(AGENT);
  await expectReply(thread, REPLIES['*']);
  seen.clean();
});

test('a page loaded directly opens in the demo index as its tab, the landing page too, and settles', async ({ context, page }) => {
  const seen = watch(context, page);
  const shown = (name: string) => page.frames().map((frame) => new URL(frame.url()))
    .find((where) => where.pathname === `/${name}.html`);

  await page.goto(`${TRY_IT}#the-pond-today`);
  await expect(page).toHaveURL(/\/pages\.html#tabs=try-it&on=try-it$/);
  await expect(page.getByRole('group', { name: 'Open pods' })).toHaveCount(1);
  await expect.poll(() => shown('try-it')?.hash).toBe('#the-pond-today');

  // The demo's / answers /readme.html, which opens in the index the same way
  // and stays there.
  await page.goto('/');
  await expect(page).toHaveURL(/\/pages\.html#tabs=readme&on=readme$/);
  await expect.poll(() => shown('readme')?.pathname).toBe('/readme.html');
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/pages\.html#tabs=readme&on=readme$/);
  seen.clean();
});

test('a demo page and the demo index send no request to /api/events, a stand-in stream never connecting', async ({ context, page }) => {
  const seen = watch(context, page);
  const streams: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events') streams.push(request.url());
  });
  await load(page, TRY_IT);
  await page.goto(`${TRY_IT}#the-pond-today`);
  await expect(page).toHaveURL(/\/pages\.html#tabs=try-it&on=try-it$/);
  await expect(page.locator('iframe.pod-frame')).toHaveCount(1);
  await page.waitForTimeout(500);
  // The index holds the stand-in stream, still connecting and never open.
  expect(await page.evaluate(() => {
    const source = new EventSource('/api/events');
    const state = source.readyState;
    source.close();
    return [state, document.documentElement.hasAttribute('data-lotuspod-events')];
  })).toEqual([0, true]);
  expect(streams, 'no request reaches /api/events').toEqual([]);
  seen.clean();
});

test('a passage comment is highlighted and gets its reply', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const passage = 'the first algae are showing';
  await drag(page, passage);
  await page.locator('button.artifact-passage-pill').click();
  const composer = panel(page).group('The pond today').locator('.artifact-passage-composer');
  await composer.locator('textarea').fill('Is the algae a worry?');
  await composer.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(composer).toHaveCount(0);
  const root = await newestRoot(page, 'try-it');
  expect(root.quote.exact).toBe(passage);
  const marks = page.locator(`.artifact-body mark.artifact-passage[data-thread="${root.id}"]`);
  await expect(marks.first()).toBeVisible();
  expect(await marks.evaluateAll((nodes) => nodes.map((node) => node.textContent).join(''))).toBe(passage);
  const thread = entry(page, root.id);
  await expect(thread.readers.locator('.artifact-comment-text')).toHaveText('Is the algae a worry?');
  await expectReply(thread, REPLIES['try-it']['the-pond-today']);
  seen.clean();
});

test('a reply, a resolution and a reopening each stay as left over a reload', async ({ context, page }) => {
  const seen = watch(context, page);
  const side = panel(page);
  await load(page, TRY_IT);
  const root = await comment(page, 'try-it', 'what-goes-in', 'What goes in', 'Is hornwort enough on its own?');
  const thread = entry(page, root.id);
  await expectReply(thread, REPLIES['try-it']['what-goes-in']);

  await thread.item.getByRole('button', { name: 'Reply', exact: true }).click();
  await thread.item.locator('form.artifact-comment-reply textarea').fill('And in a hot summer?');
  await thread.item.getByRole('button', { name: 'Send' }).click();
  await expect(thread.readers).toHaveCount(2);
  await expectReply(thread, REPLIES['try-it']['what-goes-in'], 2);
  await thread.resolve.click();
  await expect(thread.item).toBeHidden();
  await expect(side.showResolved).toHaveText('Show resolved (1)');

  await page.reload();
  await settle(page);
  await openSection(page, 'what-goes-in', 'What goes in');
  await expect(thread.item).toBeHidden();
  await side.showResolved.click();
  await expect(thread.done).toHaveText('✓ resolved · Reopen');
  await expect(thread.readers).toHaveCount(2);
  await expect(thread.agents).toHaveCount(2);
  await thread.reopen.click();
  await expect(thread.resolve).toBeVisible();

  await page.reload();
  await settle(page);
  await openSection(page, 'what-goes-in', 'What goes in');
  await expect(thread.item).toBeVisible();
  await expect(thread.done).toBeHidden();
  await expect(thread.resolve).toBeVisible();
  await expect(thread.readers.locator('.artifact-comment-text')).toHaveText(
    ['Is hornwort enough on its own?', 'And in a hot summer?']);
  await expect(thread.agents).toHaveCount(2);
  await expect(side.showResolved).toHaveCount(0);
  seen.clean();
});

test('a decision answered, changed and reloaded folds to its answer with its history and an acknowledgement', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const when = decision(page, 'decision-1');
  await when.option('This weekend').check();
  await when.save.click();
  await expect(when.saved).toContainText('Saved · This weekend');

  await page.reload();
  await settle(page);
  await expect(when.saved).toContainText('Saved · This weekend');
  await expect(when.history).toBeHidden();
  await when.change.click();
  await when.option('Next weekend').check();
  await when.save.click();
  await expect(when.saved).toContainText('Saved · Next weekend');

  await page.reload();
  await settle(page);
  await expect(when.form).toHaveClass(/artifact-decision--saved/);
  await expect(when.saved).toContainText('Saved · Next weekend');
  await expect(when.history.locator('summary')).toHaveText('1 earlier answer');
  await expect(when.history.locator('.artifact-decision-history-choice')).toHaveText(['This weekend']);

  const group = await openSection(page, 'planting-day', 'Planting day');
  const said = group.locator('.artifact-comment-item--agent');
  await expect(said).toHaveCount(2);
  await expect(said.locator('.artifact-comment-handle')).toHaveText([AGENT, AGENT]);
  await expect(said.locator('.artifact-comment-model')).toHaveText([MODEL, MODEL]);
  await expect(said.nth(0).locator('.artifact-comment-text')).toContainText('“This weekend”');
  await expect(said.nth(1).locator('.artifact-comment-text')).toContainText('“Next weekend”');
  await expect(said.nth(1).locator('.artifact-comment-text')).toContainText('scripted demo reply');
  seen.clean();
});

test('a question about a decision waits for demo-agent, then gets the decision\'s reply and records no answer', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const words = 'Is the soil warm enough by then?';
  const made = await api(page, 'POST', '/api/comments', { page: 'try-it', question: 'decision-1', text: words });
  expect(made.status).toBe(201);
  expect(made.json).toMatchObject({
    question: 'decision-1', section: 'planting-day', sectionTitle: 'Planting day', parent: null,
    quote: null, text: words, actor: { kind: 'human', name: READER }, state: 'pending', owner: AGENT,
  });
  const root = made.json.id;
  const waiting = await thread(page, root);
  expect(waiting.root.state).toBe('pending');
  expect(waiting.replies).toEqual([]);

  await expect.poll(async () => (await thread(page, root)).replies.length, { timeout: 15_000 }).toBe(1);
  const answered = await thread(page, root);
  expect(answered.root.state).toBe('answered');
  expect(answered.replies[0]).toMatchObject({
    question: 'decision-1', section: 'planting-day', parent: root, model: MODEL,
    actor: { kind: 'agent', handle: AGENT }, text: REPLIES['try-it']['decision-1'],
  });
  const answers = await api(page, 'GET', '/api/answers?page=try-it');
  expect(answers.status).toBe(200);
  expect(answers.json.questions['decision-1']).toBeUndefined();
  seen.clean();
});

test('Ask posts a decision\'s note as a question, and demo-agent\'s reply for it shows in the thread with the decision still unanswered', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const first = decision(page, 'decision-1');
  const words = 'Will the water be warm enough this weekend?';
  await first.addNote.click();
  await first.note.fill(words);
  await first.ask.click();
  await expect(first.note).toHaveValue('');
  const root = await newestRoot(page, 'try-it');
  expect(root).toMatchObject({ question: 'decision-1', text: words, parent: null });
  const thread = entry(page, root.id);
  await expect(thread.head).toHaveAttribute('aria-expanded', 'true');
  await expect(thread.readers.locator('.artifact-comment-text')).toHaveText(words);
  await expect(thread.waiting).toContainText(AGENT);
  await expect(first.chip).toHaveText('1 comment · waiting');
  await expectReply(thread, REPLIES['try-it']['decision-1']);
  await expect(first.chip).toHaveText(`1 reply · ✓ ${AGENT} answered`);
  await expect(first.hint).toHaveText('Not answered yet');
  await expect(first.saved).toBeHidden();
  const answers = await api(page, 'GET', '/api/answers?page=try-it');
  expect(answers.json.questions['decision-1']).toBeUndefined();
  seen.clean();
});

test('a decision thread\'s reply carries its question, and a reply, a resolution and a reopening each stay over a reload', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const comments = '/api/comments';
  const made = await api(page, 'POST', comments, { page: 'try-it', question: 'decision-2', text: 'Which fish?' });
  expect(made.status).toBe(201);
  const root = made.json.id;
  await expect.poll(async () => (await thread(page, root)).replies.length, { timeout: 15_000 }).toBe(1);
  expect((await thread(page, root)).replies[0].text).toBe(REPLIES['try-it']['decision-2']);

  const reply = await api(page, 'POST', comments, { page: 'try-it', parent: root, text: 'And how many?' });
  expect(reply.status).toBe(201);
  expect(reply.json).toMatchObject({ question: 'decision-2', parent: root, state: 'pending', owner: AGENT });
  await page.reload();
  await settle(page);
  const again = await thread(page, root);
  expect(again.replies.map((each: any) => each.question)).toEqual(['decision-2', 'decision-2']);
  await expect.poll(async () => (await thread(page, root)).replies.length, { timeout: 15_000 }).toBe(3);
  const replied = (await thread(page, root)).replies;
  expect(replied[2]).toMatchObject({
    question: 'decision-2', actor: { kind: 'agent', handle: AGENT }, text: REPLIES['try-it']['decision-2'],
  });

  const resolved = await api(page, 'POST', comments, { page: 'try-it', thread: root, resolved: true });
  expect(resolved.json.resolution.resolved).toBe(true);
  await page.reload();
  await settle(page);
  expect((await thread(page, root)).resolution.resolved).toBe(true);
  await api(page, 'POST', comments, { page: 'try-it', thread: root, resolved: false });
  await page.reload();
  await settle(page);
  const reopened = await thread(page, root);
  expect(reopened.resolution.resolved).toBe(false);
  expect(reopened.root.question).toBe('decision-2');
  expect(reopened.replies).toHaveLength(3);
  seen.clean();
});

test('a decision thread on a question the page does not ask, with a key serve does not take or on a stale revision is refused, and nothing is stored', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const revision = await page.locator('meta[name="lotuspod:revision"]').getAttribute('content') ?? '';
  const refused: [object, number, string][] = [
    [{ question: 'no-such-question' }, 400, 'unknown_question'],
    [{ question: 'decision-1', section: 'planting-day' }, 400, 'invalid_body'],
    [{ question: 'decision-1', quote: { exact: 'x', prefix: '', suffix: '' } }, 400, 'invalid_body'],
    [{ question: 'decision-1', parent: 1 }, 400, 'invalid_body'],
    [{ question: 'decision-1', version: 'unexpected' }, 400, 'invalid_body'],
    [{ question: 'decision-1', revision: null }, 400, 'invalid_body'],
    [{ question: 'no-such-question', revision: 7 }, 400, 'invalid_body'],
    [{ question: 'decision-1', revision: `${revision}-stale` }, 409, 'stale_page'],
  ];
  for (const [fields, status, error] of refused) {
    const sent = await api(page, 'POST', '/api/comments', { page: 'try-it', text: 'Why?', ...fields });
    expect(sent, JSON.stringify(fields)).toEqual({ status, json: { error } });
  }
  expect(await rows(page, 'try-it')).toEqual([]);
  expect((await api(page, 'GET', '/api/comments?page=try-it')).json.threads).toEqual([]);
  seen.clean();
});

// The block "deep-shelf" on try-it: its figure, its Comment, its pin, and
// the 12 hex digits of the file its frame shows.
const BLOCK = 'deep-shelf';
const BLOCK_WORDS = 'On Lilies on the deep shelf';

function block(page: Page) {
  const figure = page.locator(`figure[data-widget="${BLOCK}"]`);
  return {
    figure,
    frame: figure.locator('iframe.artifact-widget'),
    comment: figure.locator('.artifact-live-chrome').getByRole('button', { name: 'Comment', exact: true }),
    pin: figure.locator(':scope > .artifact-live-pin'),
  };
}

async function blockHash(page: Page) {
  const source = await block(page).frame.evaluate((each: HTMLIFrameElement) =>
    each.dataset.pausedSource || each.getAttribute('src') || '');
  const hash = /\.w-([0-9a-f]{12})\.html$/.exec(source)?.[1] ?? '';
  expect(hash, `the frame's file ${source} names its hash`).toMatch(/^[0-9a-f]{12}$/);
  return hash;
}

test('a block comment keeps its widget, and a block anchor serve refuses is refused with nothing stored', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const hash = await blockHash(page);
  const widget = { id: BLOCK, hash, state: '' };
  const on = (fields: object) => ({ section: 'the-pond-today', ...fields });
  const refused: [object, number, string][] = [
    [on({ widget: { ...widget, extra: 1 } }), 400, 'invalid_body'],
    [on({ widget: { ...widget, hash: 'XYZ' } }), 400, 'invalid_body'],
    [on({ widget: { ...widget, hash: hash.slice(1) } }), 400, 'invalid_body'],
    [on({ widget: { ...widget, hash: 'ABCDEF012345' } }), 400, 'invalid_body'],
    [on({ widget: { ...widget, state: 'x'.repeat(81) } }), 400, 'invalid_body'],
    [on({ widget: { ...widget, state: '\u{1F600}'.repeat(81) } }), 400, 'invalid_body'],
    [on({ widget: { ...widget, state: 'ring\u0007' } }), 400, 'invalid_body'],
    [on({ widget, quote: { exact: 'the first algae', prefix: '', suffix: '' } }), 400, 'invalid_body'],
    [{ parent: 1, widget }, 400, 'invalid_body'],
    [{ question: 'decision-1', widget }, 400, 'invalid_body'],
    [on({ widget: { ...widget, id: 'no-such-block' } }), 400, 'unknown_widget'],
    [{ section: '', widget }, 400, 'unknown_widget'],
    [{ section: 'what-goes-in', widget }, 400, 'unknown_widget'],
    [on({ widget: { ...widget, hash: '000000000000' } }), 409, 'stale_widget'],
  ];
  for (const [fields, status, error] of refused) {
    const sent = await api(page, 'POST', '/api/comments', { page: 'try-it', text: 'How deep?', ...fields });
    expect.soft(sent, JSON.stringify(fields)).toEqual({ status, json: { error } });
  }
  expect.soft(await rows(page, 'try-it'), 'refused anchors store nothing').toEqual([]);
  const sent = await api(page, 'POST', '/api/comments', { page: 'try-it', text: 'How deep?', ...on({ widget }) });
  expect(sent.status).toBe(201);
  expect(await newestRoot(page, 'try-it')).toMatchObject({ section: 'the-pond-today', widget });
  // A state is counted in characters, as serve counts it, not UTF-16 units.
  const wide = { ...widget, state: '\u{1F600}'.repeat(80) };
  const taken = await api(page, 'POST', '/api/comments', { page: 'try-it', text: 'How deep?', ...on({ widget: wide }) });
  expect(taken.status).toBe(201);
  expect(await newestRoot(page, 'try-it')).toMatchObject({ section: 'the-pond-today', widget: wide });
  seen.clean();
});

test('a comment from a block\'s Comment is stored on the block, listed and pinned there, and stays over a reload', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const live = block(page);
  const hash = await blockHash(page);
  await expect(live.pin).toBeHidden();
  await live.comment.click();
  const group = panel(page).group('The pond today');
  await expect(group.locator('.artifact-comment-on')).toHaveText(BLOCK_WORDS);
  const form = group.locator('form.artifact-comment-form');
  const field = form.locator('textarea[name="text"]');
  await expect(field).toBeFocused();
  await field.fill('How deep is the shelf?');
  await form.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(field).toHaveValue('');

  const root = await newestRoot(page, 'try-it');
  expect(root).toMatchObject({ section: 'the-pond-today', widget: { id: BLOCK, hash, state: '' } });
  const listed = entry(page, root.id);
  await expect(group.locator(`.artifact-comments-entry[data-thread="${root.id}"]`)).toHaveCount(1);
  await expect(listed.head.locator('.artifact-comments-entry-mark')).toHaveText('▣');
  await expect(listed.head.locator('.artifact-comments-entry-words')).toHaveText(BLOCK_WORDS);
  await expect(live.pin).toBeVisible();
  await expect(live.pin).toHaveText('1');

  await expectReply(listed, REPLIES['try-it']['the-pond-today']);
  const replied = await thread(page, root.id);
  expect(replied.root.widget).toEqual({ id: BLOCK, hash, state: '' });
  expect(replied.replies).toHaveLength(1);
  expect(replied.replies[0]).toMatchObject({ actor: { kind: 'agent', handle: AGENT }, widget: null });

  await page.reload();
  await settle(page);
  await expect(entry(page, root.id).head.locator('.artifact-comments-entry-words')).toHaveText(BLOCK_WORDS);
  await expect(block(page).pin).toHaveText('1');
  seen.clean();
});

test('an image chosen in a composer is refused, and nothing is attached', async ({ context, page }) => {
  const seen = watch(context, page);
  await load(page, TRY_IT);
  const group = await openSection(page, 'planting-day', 'Planting day');
  const form = group.locator('form.artifact-comment-form');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    form.getByRole('button', { name: 'Add image' }).click(),
  ]);
  await chooser.setFiles({ name: 'pond.png', mimeType: 'image/png', buffer: PNG });
  await expect(form.locator('.artifact-comment-status')).toContainText(NO_UPLOADS);
  await expect(form.locator('.artifact-comment-status')).toHaveText(
    `pond.png was not attached (${NO_UPLOADS}). Try again.`);
  await expect(form.locator('img.artifact-attach-thumb')).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  seen.clean();
});

test('what the visitor wrote stays over reloads, tabs and a minute, until "Reset demo"', async ({ context, page }) => {
  test.setTimeout(150_000);
  const seen = watch(context, page);
  const side = panel(page);
  await load(page, TRY_IT);
  await page.evaluate(() => localStorage.setItem('lotuspod:not-the-demo', 'kept'));
  const root = await comment(page, 'try-it', 'the-pond-today', 'The pond today', 'Will it freeze?');
  await expectReply(entry(page, root.id), REPLIES['try-it']['the-pond-today']);
  const fish = decision(page, 'decision-2');
  await fish.option('No').check();
  await fish.save.click();
  await expect(fish.saved).toContainText('Saved · No');

  const still = async (each: Page) => {
    await settle(each);
    await openSection(each, 'the-pond-today', 'The pond today');
    const thread = entry(each, root.id);
    await expect(thread.readers.locator('.artifact-comment-text')).toHaveText('Will it freeze?');
    await expect(thread.agents).toHaveCount(1);
    await expect(decision(each, 'decision-2').saved).toContainText('Saved · No');
  };
  await page.reload();
  await still(page);
  const second = await context.newPage();
  await second.goto(`${TRY_IT}?standalone`);
  await still(second);
  await second.close();
  await page.waitForTimeout(60_000);
  await page.reload();
  await still(page);

  expect((await demoKeys(page)).length).toBeGreaterThan(0);
  // The open panel covers the banner's right end, where the button is.
  await side.fold.click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Reset demo' }).click(),
  ]);
  await settle(page);
  expect(await demoKeys(page)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('lotuspod:not-the-demo'))).toBe('kept');
  // Each section's box and the whole page's.
  await expect(page.locator('details.artifact-comment > summary.artifact-comment-chip--none')).toHaveCount(4);
  await expect(side.entries).toHaveCount(0);
  // With no answer stored, each decision has its default picked, not saved
  // (js/review-sheet.js), so it reads "Not saved" rather than "Not answered yet".
  for (const [question, fallback] of [['decision-1', 'Next weekend'], ['decision-2', 'No']]) {
    const form = decision(page, question);
    await expect(form.form).not.toHaveClass(/artifact-decision--saved/);
    await expect(form.saved).toHaveCount(0);
    await expect(form.option(fallback)).toBeChecked();
    await expect(form.hint).toBeHidden();
  }
  seen.clean();
});

test('no request of the whole run reached /api/ on the static server', async () => {
  const log = process.env.LOTUSPOD_DEMO_LOG ?? '';
  expect(log, 'python -m demo.build --serve names the request log').toBeTruthy();
  const lines = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  const paths = lines.map((line) => line.split(' ')[1] ?? '');
  expect(paths).toContain('/try-it.html');
  expect(paths).toContain('/lotuspod-demo.js');
  expect(paths.filter((each) => each.startsWith('/api/'))).toEqual([]);
});
