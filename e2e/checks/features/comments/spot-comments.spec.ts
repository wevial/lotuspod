import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

// Comments on a spot of a diagram or an image. The check publishes pages of
// its own as hermes on the capture fixture's site with a real `lotuspod
// publish`: a section Flow drawing the flowchart `flow` (Agent, Publish, Pod,
// Reader) with its Nodes table, and a section Pictures with the fixture's
// fish. The reader presses a target's Comment, marks a spot with a box, a
// stroke, a click or the keyboard and posts; the page is published again with
// the flowchart laid out top to bottom, then without Pod, each swap applied in
// place. The run shares one database, so each repeat publishes pages of its
// own names.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const FISH = path.resolve(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'media', 'fish-320x240.jpg');
// The pinned Mermaid (e2e/package.json) answers jsDelivr's requests for it,
// as in diagram-view.spec.ts.
const MERMAID_DIR = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
const MERMAID_COPY = path.join(__dirname, '..', '..', '..', 'node_modules', 'mermaid');
// features/publish/ts/page-open.js's STALE_DIAGRAM.
const STALE_DIAGRAM = 'This diagram has changed since the page loaded. Reload the page to comment on its new version.';
const CHANGED = 'Diagram changed since this comment';
// What an image spot's composer says when its crop was not stored.
const CROP_FAILED = 'The crop of the marked spot was not attached. Press Comment to try again.';
const QUESTION = 'Is this the pod?';
// features/publish/ts/page-open.js's PLACE_GONE.
const PLACE_GONE = 'Where you were writing has changed since. Your text is kept here.';
// What features/live/ts/live-page.js keeps over a reload, per page.
const KEPT = 'lotuspod:reload:';

test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

// The page: Flow's flowchart laid out as layout says, its chain as given,
// and the fish under Pictures unless fish is false.
function doc(layout = 'LR', chain = 'Agent --> Publish --> Pod --> Reader', fish = true) {
  const ids = chain.split(' --> ');
  return ['# Spot study', '', 'Where a comment on a drawing lands.', '',
    '## Flow', '', 'How a page reaches its reader.', '',
    '```mermaid id=flow', `graph ${layout}`, `  ${chain}`, '```', '',
    '### Nodes', '', '| Node | Title | Status |', '|---|---|---|',
    ...ids.map((id) => `| ${id} | The ${id.toLowerCase()} step | merged |`), '',
    '## Pictures', '', 'The pond as it is.', '', ...(fish ? ['![Fish](fish.jpg)', ''] : [])].join('\n');
}

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, markdown: string, comments = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-spot-comments-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    fs.copyFileSync(FISH, path.join(dir, 'fish.jpg'));
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, comments ? '--comments' : '--no-comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Page errors, and Mermaid answered from the pinned copy.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${MERMAID_DIR}**`, async (route) => {
    const file = path.join(MERMAID_COPY, route.request().url().slice(MERMAID_DIR.length));
    if (!file.startsWith(MERMAID_COPY + path.sep) || !fs.existsSync(file)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(file),
    });
  });
  return errors;
}

function diagram(page: Page) {
  const pre = page.locator('pre.mermaid[data-spot="flow"]');
  const named = (name: string) => pre.getByRole('button', { name, exact: true });
  return {
    pre,
    svg: pre.locator(':scope > svg'),
    comment: named('Comment'), box: named('Box'), stroke: named('Stroke'), cancel: named('Cancel'),
    marks: pre.locator('g.artifact-spot-mark:not(.artifact-spot-mark--draft)'),
    draft: pre.locator('g.artifact-spot-mark--draft'),
    node: (id: string) => pre.locator(`g.node[id^="flowchart-${id}-"]`),
  };
}

function figure(page: Page) {
  const node = page.locator('figure.artifact-figure').filter({ has: page.locator('img[alt="Fish"]') });
  return {
    node, img: node.locator('img'),
    comment: node.getByRole('button', { name: 'Comment', exact: true }),
    marks: node.locator('g.artifact-spot-mark:not(.artifact-spot-mark--draft)'),
  };
}

function composer(page: Page) {
  const holder = page.locator('.artifact-spot-composer');
  return {
    holder,
    field: holder.locator('textarea[name="text"]'),
    send: holder.getByRole('button', { name: 'Comment', exact: true }),
    cancel: holder.getByRole('button', { name: 'Cancel', exact: true }),
    status: holder.locator('.artifact-comment-status'),
  };
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  const group = (title: string) => aside.locator('.artifact-comments-group')
    .filter({ has: page.locator(':scope > .artifact-comments-group-title', { hasText: title }) });
  return { aside, group, strays: group('Sections that have changed') };
}

// Load a page on its own; once its diagram is drawn and its threads read.
async function load(page: Page, name: string) {
  await page.goto(`/${name}.html?standalone`);
  await expect(diagram(page).svg).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
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
  await expect(diagram(page).svg).toBeVisible();
}

// Publish the page again while a draft holds Flow back, and apply the
// swap with Flow's Update once it has redrawn the diagram.
async function update(page: Page, name: string, markdown: string) {
  const held = page.locator('.artifact-swap-held').getByRole('button', { name: 'Update', exact: true });
  publish(name, markdown);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(held).toBeVisible();
  const old = await diagram(page).pre.evaluate((pre) => { (pre as any).old = true; return true; });
  expect(old).toBe(true);
  await held.click();
  await expect.poll(() => diagram(page).pre.evaluate((pre) => !(pre as any).old)).toBe(true);
  await expect(diagram(page).svg).toBeVisible();
}

// The comment the page posts next, as the route receives it.
function posting(page: Page): Promise<Request> {
  return page.waitForRequest((request) => new URL(request.url()).pathname === '/api/comments' &&
    request.method() === 'POST' && 'text' in (request.postDataJSON() ?? {}));
}

// A press at from, moved in steps to to, and released.
async function drag(page: Page, from: [number, number], to: [number, number], steps = 10) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
}

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

// A box drawn 12 px round node.
async function boxRound(page: Page, node: Locator) {
  const at = await rect(node);
  await drag(page, [at.x - 12, at.y - 12], [at.x + at.width + 12, at.y + at.height + 12]);
}

// Whether the mark's shape holds node's drawn box.
async function holds(mark: Locator, node: Locator) {
  const outer = await mark.locator('.artifact-spot-shape').boundingBox();
  const inner = await node.boundingBox();
  if (!outer || !inner) return false;
  return outer.x <= inner.x + 0.5 && outer.y <= inner.y + 0.5 &&
    outer.x + outer.width >= inner.x + inner.width - 0.5 && outer.y + outer.height >= inner.y + inner.height - 0.5;
}

// Post what the composer holds; the request's body and the stored row.
async function post(page: Page, text: string) {
  const form = composer(page);
  await expect(form.field).toBeFocused();
  await form.field.fill(text);
  const sent = posting(page);
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.click();
  const body = (await sent).postDataJSON();
  const response = await answered;
  expect(response.status()).toBe(201);
  await expect(form.holder).toHaveCount(0);
  return { body, row: await response.json() };
}

async function openEntry(entry: Locator) {
  const head = entry.locator('.artifact-comments-entry-head');
  if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
}

test('a box round a node is posted, drawn round it after a reload and in Dawn, and follows it across republishes', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  const name = `spot-comments-check-${test.info().repeatEachIndex}`;
  publish(name, doc());
  const errors = await watch(page);
  await load(page, name);
  const flow = diagram(page);
  const side = panel(page);

  await expect(flow.comment).toBeVisible();
  await flow.comment.click();
  await expect(flow.box).toHaveAttribute('aria-pressed', 'true');
  await expect(flow.stroke).toHaveAttribute('aria-pressed', 'false');
  await expect(flow.comment).toHaveCount(0);
  await boxRound(page, flow.node('Pod'));
  await expect(flow.draft).toHaveCount(1);
  const hash = await flow.pre.getAttribute('data-spot-hash');
  const { body } = await post(page, QUESTION);
  expect(body.spot.id).toBe('flow');
  expect(body.spot.hash).toBe(hash);
  expect(body.spot.shape.kind).toBe('box');
  expect(body.spot.nodes).toEqual([{ id: 'Pod', label: 'Pod' }]);
  expect(body.section).toBe('flow');
  expect(body.text).toBe(QUESTION);
  // Posted, mark mode is over and the mark is drawn solid.
  await expect(flow.comment).toBeVisible();
  await expect(flow.marks).toHaveCount(1);

  await page.reload();
  await expect(flow.svg).toBeVisible();
  await expect(flow.marks).toHaveCount(1);
  const mark = flow.marks.first();
  await expect(mark).not.toHaveClass(/artifact-spot-mark--changed/);
  await expect.poll(() => holds(mark, flow.node('Pod'))).toBe(true);
  await expect(mark.locator('.artifact-spot-badge')).toHaveText('1');
  const entry = side.group('Flow').locator('.artifact-comments-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.artifact-comments-entry-head .artifact-comments-entry-mark')).toHaveText('1');

  // Mermaid draws the diagram again in Dawn: the mark is placed again on it.
  const before = await flow.svg.evaluate((svg) => { (svg as any).old = true; return svg.id; });
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dawn', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dawn');
  await expect.poll(() => flow.svg.evaluate((svg) => !(svg as any).old)).toBe(true);
  expect(before).toBeTruthy();
  await expect(flow.marks).toHaveCount(1);
  await expect.poll(() => holds(flow.marks.first(), flow.node('Pod'))).toBe(true);
  await expect(flow.marks.first().locator('.artifact-spot-badge')).toHaveText('1');
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Night', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');

  // On Auto, a mark lit by its hovered row stays lit when the system's
  // scheme turns light and Mermaid draws the diagram again. The pointer stays
  // on the row: the theme buttons are pressed from the page.
  const theme = (label: string) => page.getByRole('group', { name: 'Theme' })
    .getByRole('button', { name: label, exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  await theme('Auto');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await entry.hover();
  await expect(flow.marks.first()).toHaveClass(/artifact-spot-mark--lit/);
  await flow.svg.evaluate((svg) => { (svg as any).old = true; });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dawn');
  await expect.poll(() => flow.svg.evaluate((svg) => !(svg as any).old)).toBe(true);
  await expect(flow.marks).toHaveCount(1);
  await expect(flow.marks.first()).toHaveClass(/artifact-spot-mark--lit/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await theme('Night');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.mouse.move(0, 0);

  // Laid out top to bottom: Pod is elsewhere, and the mark dashed round it.
  await swap(page, name, doc('TD'));
  await expect(flow.marks).toHaveCount(1);
  await expect(flow.marks.first()).toHaveClass(/artifact-spot-mark--changed/);
  await expect.poll(() => holds(flow.marks.first(), flow.node('Pod'))).toBe(true);
  await openEntry(entry);
  await expect(entry.getByText(CHANGED, { exact: true })).toBeVisible();
  await page.reload();
  await expect(flow.svg).toBeVisible();
  await expect(flow.marks).toHaveCount(1);
  await expect(flow.marks.first()).toHaveClass(/artifact-spot-mark--changed/);
  await expect.poll(() => holds(flow.marks.first(), flow.node('Pod'))).toBe(true);
  await openEntry(entry);
  await expect(entry.getByText(CHANGED, { exact: true })).toBeVisible();

  // Without Pod: nothing is drawn, and the thread is with the changed sections.
  await swap(page, name, doc('TD', 'Agent --> Publish --> Reader'));
  await expect(flow.node('Reader')).toHaveCount(1);
  await expect(flow.pre.locator('g.artifact-spot-mark')).toHaveCount(0);
  const stray = side.strays.locator('.artifact-comments-entry');
  await expect(stray).toHaveCount(1);
  await expect(stray.locator('.artifact-comments-entry-words').first()).toHaveText('On Pod');
  // Its number is a muted ring, not the rose of a mark.
  const ring = await stray.locator('.artifact-comments-entry-mark').first().evaluate((mark) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-rose)';
    document.body.appendChild(probe);
    const rose = getComputedStyle(probe).color;
    probe.remove();
    const seen = getComputedStyle(mark);
    return { rose, border: seen.borderTopColor, color: seen.color, fill: seen.backgroundColor };
  });
  expect(ring.border).not.toBe(ring.rose);
  expect(ring.color).not.toBe(ring.rose);
  expect(ring.fill).toBe('rgba(0, 0, 0, 0)');
  await expect(side.group('Flow').locator('.artifact-comments-entry')).toHaveCount(0);
  await page.reload();
  await expect(flow.svg).toBeVisible();
  await expect(flow.pre.locator('g.artifact-spot-mark')).toHaveCount(0);
  await expect(stray).toHaveCount(1);
  await expect(stray.locator('.artifact-comments-entry-words').first()).toHaveText('On Pod');
  expect(errors).toEqual([]);
});

test('a stroke, a click on a node and the keyboard mark spots; Escape drops a draft; a stale hash is refused', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-marks-${test.info().repeatEachIndex}`;
  publish(name, doc());
  const errors = await watch(page);
  await load(page, name);
  const flow = diagram(page);
  const form = composer(page);

  // A stroke drawn under Reader.
  await flow.comment.click();
  await flow.stroke.click();
  await expect(flow.stroke).toHaveAttribute('aria-pressed', 'true');
  await expect(flow.box).toHaveAttribute('aria-pressed', 'false');
  const reader = await rect(flow.node('Reader'));
  const under = reader.y + reader.height + 3;
  await drag(page, [reader.x + 4, under], [reader.x + reader.width - 4, under - 1], 30);
  const stroked = (await post(page, 'Underlined')).body.spot;
  expect(stroked.shape.kind).toBe('stroke');
  expect(stroked.shape.points.length).toBeGreaterThanOrEqual(2);
  expect(stroked.shape.points.length).toBeLessThanOrEqual(256);

  // A thin box over Pod's left edge covers less than half of itself, so it
  // names no node, as the stroke's widening would have it do.
  // Chromium's client box of an svg group is its geometry, the stroke left
  // out; it is read once Comment has brought the diagram into view.
  await flow.comment.click();
  const edge = await flow.node('Pod').evaluate((group) => {
    const box = group.getBoundingClientRect();
    return { x: box.left, y: box.top + box.height / 2 };
  });
  await drag(page, [edge.x - 0.9, edge.y - 20], [edge.x + 0.6, edge.y + 20]);
  const thin = (await post(page, 'Just beside Pod')).body.spot;
  expect(thin.shape.kind).toBe('box');
  expect(thin.nodes).toEqual([]);

  // A click on Agent marks Agent, and opens no node card.
  await flow.comment.click();
  await flow.node('Agent').click();
  await expect(flow.draft).toHaveCount(1);
  await expect(page.locator('#artifact-node-card:not([hidden])')).toHaveCount(0);
  const clicked = (await post(page, 'Which agent?')).body.spot;
  expect(clicked.shape.kind).toBe('box');
  expect(clicked.nodes).toEqual([{ id: 'Agent', label: 'Agent' }]);
  // In fractions of the box Agent spans, the box holds all of it.
  expect(clicked.shape.x).toBeLessThan(0);
  expect(clicked.shape.y).toBeLessThan(0);
  expect(clicked.shape.x + clicked.shape.w).toBeGreaterThan(1);
  expect(clicked.shape.y + clicked.shape.h).toBeGreaterThan(1);
  await expect(page.locator('#artifact-node-card:not([hidden])')).toHaveCount(0);

  // Tab to Pod, Enter, then Cmd+Enter (Ctrl+Enter off macOS) posts.
  await flow.comment.click();
  await expect(flow.box).toBeFocused();
  const pod = flow.node('Pod');
  for (let n = 0; n < 12 && !(await pod.evaluate((node) => node === document.activeElement)); n++) {
    await page.keyboard.press('Tab');
  }
  await expect(pod).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(form.field).toBeFocused();
  await page.keyboard.type('By keyboard');
  const sent = posting(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  const keyed = (await sent).postDataJSON().spot;
  expect(keyed.shape.kind).toBe('box');
  expect(keyed.nodes).toEqual([{ id: 'Pod', label: 'Pod' }]);
  await expect(form.holder).toHaveCount(0);
  await expect(page.locator('#artifact-node-card:not([hidden])')).toHaveCount(0);

  // Escape drops the draft and stays in mark mode; Escape again leaves it.
  const posts: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/comments' && request.method() === 'POST') posts.push(request.url());
  });
  await flow.comment.click();
  await boxRound(page, flow.node('Reader'));
  await expect(flow.draft).toHaveCount(1);
  await form.field.fill('Never sent');
  await page.keyboard.press('Escape');
  await expect(flow.draft).toHaveCount(0);
  await expect(form.holder).toHaveCount(0);
  await expect(flow.box).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(flow.box).toHaveCount(0);
  await expect(flow.comment).toBeFocused();
  expect(posts).toEqual([]);

  // A draft keeps its mark and its text while Mermaid draws the diagram again
  // in the other theme.
  const themes = page.getByRole('group', { name: 'Theme' });
  const redrawn = async (theme: 'Dawn' | 'Night') => {
    await flow.svg.evaluate((svg) => { (svg as any).old = true; });
    await themes.getByRole('button', { name: theme, exact: true }).click();
    await expect.poll(() => flow.svg.evaluate((svg) => !(svg as any).old)).toBe(true);
  };
  await flow.comment.click();
  await boxRound(page, flow.node('Reader'));
  await form.field.fill('Still here');
  await redrawn('Dawn');
  await expect(flow.draft).toHaveCount(1);
  await expect(form.field).toHaveValue('Still here');
  await redrawn('Night');
  await expect(flow.draft).toHaveCount(1);
  await expect(form.field).toHaveValue('Still here');
  await form.field.focus();
  await page.keyboard.press('Escape');
  await expect(form.holder).toHaveCount(0);

  // A save that ends after its draft was dropped leaves a newer draft as it is.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route('**/api/comments', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  await boxRound(page, flow.node('Agent'));
  await form.field.fill('Saved late');
  const late = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.click();
  await form.cancel.click();
  await expect(form.holder).toHaveCount(0);
  await boxRound(page, flow.node('Reader'));
  await form.field.fill('Newer');
  release();
  expect((await late).status()).toBe(201);
  await page.unroute('**/api/comments');
  await expect(flow.marks).toHaveCount(5);
  await expect(flow.draft).toHaveCount(1);
  await expect(form.field).toHaveValue('Newer');
  await expect(flow.box).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(flow.comment).toBeFocused();

  // Escape in the middle of a drag leaves mark mode with no draft drawn.
  await flow.comment.click();
  const agent = await rect(flow.node('Agent'));
  await page.mouse.move(agent.x - 6, agent.y - 6);
  await page.mouse.down();
  await page.mouse.move(agent.x + agent.width, agent.y + agent.height, { steps: 6 });
  await expect(flow.draft).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(flow.comment).toBeVisible();
  await expect(flow.draft).toHaveCount(0);
  await expect(form.holder).toHaveCount(0);

  // A hash the diagram never had is refused, and the text kept.
  await flow.comment.click();
  await boxRound(page, flow.node('Reader'));
  await form.field.fill('Kept');
  await flow.pre.evaluate((pre) => pre.setAttribute('data-spot-hash', 'abcdefabcdef'));
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.click();
  const answer = await refused;
  expect(answer.status()).toBe(409);
  expect((await answer.json()).error).toBe('stale_spot');
  await expect(form.status).toHaveText(STALE_DIAGRAM);
  await expect(form.field).toHaveValue('Kept');

  // A republish holds Flow back while the draft is open. Its Update swaps
  // the diagram in: the draft is drawn round Reader's new place, its text
  // kept, and posts on the new diagram.
  await update(page, name, doc('TD'));
  await expect(form.field).toHaveValue('Kept');
  await expect(flow.draft).toHaveCount(1);
  await expect.poll(() => holds(flow.draft, flow.node('Reader'))).toBe(true);
  const fresh = await flow.pre.getAttribute('data-spot-hash');
  expect(fresh).not.toBe('abcdefabcdef');
  await form.field.fill('Kept across Update');
  const moved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.click();
  const across = await moved;
  expect(across.status()).toBe(201);
  const acrossSpot = across.request().postDataJSON().spot;
  expect(acrossSpot.hash).toBe(fresh);
  expect(acrossSpot.nodes).toEqual([{ id: 'Reader', label: 'Reader' }]);
  await expect(form.holder).toHaveCount(0);

  // With the draft's node gone, Update keeps the composer and its text, and
  // draws no draft.
  await flow.comment.click();
  await boxRound(page, flow.node('Reader'));
  await form.field.fill('Kept without Reader');
  await update(page, name, doc('TD', 'Agent --> Publish --> Pod'));
  await expect(flow.node('Pod')).toHaveCount(1);
  await expect(flow.node('Reader')).toHaveCount(0);
  await expect(form.holder).toHaveCount(1);
  await expect(form.field).toHaveValue('Kept without Reader');
  await expect(flow.draft).toHaveCount(0);
  await form.cancel.click();
  await expect(form.holder).toHaveCount(0);
  // Mark mode is on the diagram Update drew, and its Box has the focus.
  await expect(flow.box).toBeFocused();

  // The diagram moved under Pictures, the sections in the same order: Flow's
  // Update brings the draft to it, and its thread is Pictures'. Escape left
  // mark mode on.
  await boxRound(page, flow.node('Pod'));
  await form.field.fill('Moved with it');
  const [head, flowPart, pictures] = doc('TD', 'Agent --> Publish --> Pod').split(/(?=## Flow|## Pictures)/);
  const diagramSource = /```mermaid id=flow[\s\S]*?```\n/.exec(flowPart)![0];
  publish(name, head + flowPart.replace(diagramSource, '') + pictures + '\n' + diagramSource);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const flowUpdate = page.locator('.artifact-swap-held').getByRole('button', { name: 'Update', exact: true });
  await expect(flowUpdate).toBeVisible();
  await flowUpdate.click();
  await expect(flow.pre).toHaveCount(1);
  await expect(page.locator('h2#flow + .artifact-section-body pre.mermaid')).toHaveCount(0);
  await expect(page.locator('h2#pictures + .artifact-section-body pre.mermaid[data-spot="flow"] > svg')).toBeVisible();
  await expect(form.field).toHaveValue('Moved with it');
  await expect(flow.draft).toHaveCount(1);
  const movedAnswer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.click();
  const movedTo = await movedAnswer;
  expect(movedTo.status()).toBe(201);
  expect(movedTo.request().postDataJSON().section).toBe('pictures');
  await expect(form.holder).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a box on an image is posted in its natural pixels with a crop of it, and drawn there after a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-image-${test.info().repeatEachIndex}`;
  publish(name, doc());
  const errors = await watch(page);
  await load(page, name);
  const fish = figure(page);
  await fish.img.scrollIntoViewIfNeeded();
  await expect.poll(() => fish.img.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  await expect(fish.comment).toBeVisible();
  await fish.comment.click();
  // Mark mode shows its crosshair over the image before any press.
  await expect.poll(() => fish.node.locator('svg.artifact-spot-overlay')
    .evaluate((over) => getComputedStyle(over).cursor)).toBe('crosshair');
  const shown = await rect(fish.img);
  const from: [number, number] = [shown.x + shown.width * 0.2, shown.y + shown.height * 0.25];
  const to: [number, number] = [shown.x + shown.width * 0.6, shown.y + shown.height * 0.7];
  await drag(page, from, to);
  const form = composer(page);
  // Sent twice at once while the crop uploads, the comment waits for it and
  // is posted once, the crop its first image.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route('**/api/media', async (route) => {
    await held;
    await route.continue();
  });
  const comments: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/comments' && request.method() === 'POST') comments.push(request.url());
  });
  await expect(form.field).toBeFocused();
  await form.field.fill('This fin');
  const sent = posting(page);
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(form.send).toBeDisabled();
  release();
  const body = (await sent).postDataJSON();
  const response = await answered;
  expect(response.status()).toBe(201);
  const row = await response.json();
  await page.unroute('**/api/media');
  await expect(form.holder).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(comments).toHaveLength(1);
  const shape = body.spot.shape;
  expect(body.spot.nodes).toEqual([]);
  expect(shape.kind).toBe('box');
  const scale = 320 / shown.width;
  expect(shape.x).toBeCloseTo((from[0] - shown.x) * scale, 0);
  expect(shape.y).toBeCloseTo((from[1] - shown.y) * scale, 0);
  expect(shape.w).toBeCloseTo((to[0] - from[0]) * scale, 0);
  expect(shape.h).toBeCloseTo((to[1] - from[1]) * scale, 0);
  expect(shape.x).toBeGreaterThanOrEqual(0);
  expect(shape.y).toBeGreaterThanOrEqual(0);
  expect(shape.x + shape.w).toBeLessThanOrEqual(320);
  expect(shape.y + shape.h).toBeLessThanOrEqual(240);
  const image = row.images[0];
  expect(image.name).toMatch(/^[0-9a-f]{64}\.png$/);
  expect(image.width).toBe(Math.round(shape.w));
  expect(image.height).toBe(Math.round(shape.h));

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  await fish.img.scrollIntoViewIfNeeded();
  await expect(fish.marks).toHaveCount(1);
  const again = await rect(fish.img);
  const drawn = await rect(fish.marks.first().locator('.artifact-spot-shape'));
  // Within the half of the mark's line its box takes in on each side.
  expect(Math.abs(drawn.x - (again.x + from[0] - shown.x))).toBeLessThanOrEqual(2);
  expect(Math.abs(drawn.y - (again.y + from[1] - shown.y))).toBeLessThanOrEqual(2);
  expect(Math.abs(drawn.width - (to[0] - from[0]))).toBeLessThanOrEqual(4);
  expect(Math.abs(drawn.height - (to[1] - from[1]))).toBeLessThanOrEqual(4);
  // In mark mode the crosshair holds over a posted mark too.
  await expect(fish.marks.first().locator('.artifact-spot-shape')).toHaveCSS('cursor', 'pointer');
  await fish.comment.click();
  await expect(fish.marks.first().locator('.artifact-spot-shape')).toHaveCSS('cursor', 'crosshair');
  await page.keyboard.press('Escape');
  await expect(fish.comment).toBeVisible();

  // A crop the site refuses is never posted without: a send attaches it
  // again, and while the site still refuses it, says so and keeps the text;
  // a send once it is stored posts it.
  await page.route('**/api/media', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"broken"}' }));
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/media');
  await fish.comment.click();
  await drag(page, from, to);
  await refused;
  comments.length = 0;
  await form.field.fill('Again');
  await form.send.click();
  await expect(form.status).toHaveText(CROP_FAILED);
  await expect(form.field).toHaveValue('Again');
  expect(comments).toEqual([]);
  await page.unroute('**/api/media');
  const resent = posting(page);
  await form.send.click();
  const retried = (await resent).postDataJSON();
  expect(retried.images).toHaveLength(1);
  expect(retried.images[0]).toMatch(/^[0-9a-f]{64}\.png$/);
  await expect(form.holder).toHaveCount(0);

  // A crop the canvas cannot make leaves the send able to go again: it says
  // so, keeps the text, and posts once a crop is made.
  await page.evaluate(() => {
    (window as any).toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function () { throw new Error('no canvas'); };
  });
  await fish.img.scrollIntoViewIfNeeded();
  await fish.comment.click();
  const broken = await rect(fish.img);
  await drag(page, [broken.x + broken.width * 0.3, broken.y + broken.height * 0.3], [broken.x + broken.width * 0.5, broken.y + broken.height * 0.5]);
  comments.length = 0;
  await form.field.fill('No canvas');
  await form.send.click();
  await expect(form.status).toHaveText(CROP_FAILED);
  await expect(form.send).toBeEnabled();
  await expect(form.field).toHaveValue('No canvas');
  expect(comments).toEqual([]);
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = (window as any).toBlob; });
  const mended = posting(page);
  await form.send.click();
  expect((await mended).postDataJSON().images).toHaveLength(1);
  await expect(form.holder).toHaveCount(0);

  // A crop the reader takes out once it has uploaded is made and attached
  // again by the send, and posted as the first image: another PNG of the
  // same size, attached in its place, is not taken for it.
  await fish.img.scrollIntoViewIfNeeded();
  await fish.comment.click();
  const now = await rect(fish.img);
  await drag(page, [now.x + now.width * 0.2, now.y + now.height * 0.25], [now.x + now.width * 0.6, now.y + now.height * 0.7]);
  const cropLink = form.holder.locator('a.artifact-attach-link');
  await expect(cropLink).toHaveCount(1);
  const cropName = path.basename(new URL((await cropLink.getAttribute('href'))!, page.url()).pathname);
  const cropSize = await cropLink.locator('img').evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  await form.holder.locator('.artifact-attach-remove').click();
  await expect(form.holder.locator('.artifact-attach-item')).toHaveCount(0);
  const other = Buffer.from(await page.evaluate(([w, h]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3a7';
    context.fillRect(0, 0, w, h);
    return canvas.toDataURL('image/png').split(',')[1];
  }, cropSize), 'base64');
  await form.holder.locator('input[type="file"]').setInputFiles({ name: 'other.png', mimeType: 'image/png', buffer: other });
  await expect(form.holder.locator('a.artifact-attach-link')).toHaveCount(1);
  const otherName = path.basename(new URL((await form.holder.locator('a.artifact-attach-link').getAttribute('href'))!, page.url()).pathname);
  expect(otherName).not.toBe(cropName);
  await form.field.fill('Without it?');
  const recropped = posting(page);
  const recroppedRow = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.click();
  const third = (await recropped).postDataJSON();
  expect(third.images).toEqual([cropName, otherName]);
  const thirdRow = await recroppedRow;
  expect(thirdRow.status()).toBe(201);
  const thirdImage = (await thirdRow.json()).images[0];
  expect(thirdImage.name).toBe(third.images[0]);
  expect(thirdImage.width).toBe(Math.round(third.spot.shape.w));
  expect(thirdImage.height).toBe(Math.round(third.spot.shape.h));
  await expect(form.holder).toHaveCount(0);

  // A box dragged past the image's far corner stays within it once rounded.
  await fish.comment.click();
  const edge = await rect(fish.img);
  await drag(page, [edge.x + edge.width * 0.333, edge.y + edge.height * 0.4], [edge.x + edge.width + 20, edge.y + edge.height + 20]);
  await expect(form.holder.locator('a.artifact-attach-link')).toHaveCount(1);
  const { body: edged, row: edgedRow } = await post(page, 'To the corner');
  const corner = edged.spot.shape;
  expect(corner.x).toBeGreaterThanOrEqual(0);
  expect(corner.y).toBeGreaterThanOrEqual(0);
  expect(corner.x + corner.w).toBeLessThanOrEqual(320);
  expect(corner.y + corner.h).toBeLessThanOrEqual(240);
  expect(corner.x + corner.w).toBeGreaterThan(319.9);
  expect(edgedRow.images[0].width).toBe(Math.round(corner.w));
  expect(edgedRow.images[0].height).toBe(Math.round(corner.h));

  // Cancelled while its crop uploads, a send posts nothing.
  let letGo!: () => void;
  const slow = new Promise<void>((done) => { letGo = done; });
  await page.route('**/api/media', async (route) => {
    await slow;
    await route.continue();
  });
  await fish.comment.click();
  await drag(page, from, to);
  comments.length = 0;
  await form.field.fill('Never mind');
  await form.send.click();
  await expect(form.send).toBeDisabled();
  await form.cancel.click();
  await expect(form.holder).toHaveCount(0);
  letGo();
  await page.waitForTimeout(500);
  await page.unroute('**/api/media');
  expect(comments).toEqual([]);

  // Without the fish, its threads are under the changed sections, headed
  // with its alt text, and so after a reload. Mark mode is left and the
  // focus taken out of Pictures, which a swap would hold back.
  await page.keyboard.press('Escape');
  await expect(fish.comment).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await swap(page, name, doc('LR', undefined, false));
  await expect(fish.node).toHaveCount(0);
  const strays = panel(page).strays.locator('.artifact-comments-entry');
  const headings = () => strays.evaluateAll((entries) =>
    entries.map((entry) => entry.querySelector('.artifact-comments-entry-words')?.textContent));
  await expect(strays).toHaveCount(5);
  await expect.poll(headings).toEqual(Array(5).fill('On Fish'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  await expect(strays).toHaveCount(5);
  await expect.poll(headings).toEqual(Array(5).fill('On Fish'));
  expect(errors).toEqual([]);
});

test('a spot draft holds back a hidden page\'s reload, and its text is kept over the reload', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-kept-${test.info().repeatEachIndex}`;
  publish(name, doc());
  const errors = await watch(page);
  await load(page, name);
  const flow = diagram(page);
  const form = composer(page);
  await flow.comment.click();
  await boxRound(page, flow.node('Pod'));
  await form.field.fill('Not sent yet');

  // Hidden, the page keeps the draft's text for its section.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const kept = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), KEPT + name);
  const texts = kept?.comments?.texts ?? [];
  const draft = texts.find((each: { text?: string }) => each.text === 'Not sent yet');
  expect(draft, `the kept texts ${JSON.stringify(texts)} hold the spot draft's`).toBeTruthy();
  expect(draft.section).toBe('flow');

  // A republish that moves the sections round is not swapped in: the hidden
  // page offers a reload rather than taking it, the draft as it was.
  const [head, flowPart, pictures] = doc().split(/(?=## Flow|## Pictures)/);
  publish(name, head + pictures + '\n' + flowPart);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const reload = page.locator('.artifact-live-page-banner').getByRole('button', { name: 'Reload' });
  await expect(reload).toBeVisible();
  await expect(form.field).toHaveValue('Not sent yet');

  // Reloaded, the text is in Flow's form, saying why.
  const loaded = page.waitForEvent('load');
  await reload.click();
  await loaded;
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  const flowForm = panel(page).group('Flow').locator('form.artifact-comment-form');
  await expect(flowForm.locator('textarea[name="text"]')).toHaveValue('Not sent yet');
  await expect(flowForm.locator('.artifact-comment-status')).toHaveText(PLACE_GONE);
  expect(errors).toEqual([]);
});

test('an image still uploading in a spot draft is waited for by Reload and kept with its text', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-kept-image-${test.info().repeatEachIndex}`;
  publish(name, doc());
  const errors = await watch(page);
  await load(page, name);
  const flow = diagram(page);
  const form = composer(page);
  await flow.comment.click();
  await boxRound(page, flow.node('Pod'));
  await form.field.fill('Not sent yet');
  let release!: () => void;
  const released = new Promise<void>((done) => { release = done; });
  await page.route('**/api/media', async (route) => {
    await released;
    await route.continue();
  });
  const base64 = fs.readFileSync(FISH).toString('base64');
  await form.field.evaluate((node, base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'fish.jpg', { type: 'image/jpeg' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, base64);
  await expect(page.locator('.artifact-attach-item--loading')).toHaveCount(1);

  // Hidden, with an image on its way, the page offers a reload of a
  // republish that moves the sections round rather than taking it.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  });
  const [head, flowPart, pictures] = doc().split(/(?=## Flow|## Pictures)/);
  publish(name, head + pictures + '\n' + flowPart);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const reload = page.locator('.artifact-live-page-banner').getByRole('button', { name: 'Reload' });
  await expect(reload).toBeVisible();

  // Reload waits for the upload: no load until it is answered.
  let loads = 0;
  page.on('load', () => { loads += 1; });
  const fetched = page.waitForResponse((response) => new URL(response.url()).pathname === `/${name}.html` &&
    response.request().resourceType() === 'fetch');
  const loaded = page.waitForEvent('load');
  await reload.click();
  await fetched;
  await expect(reload).toBeDisabled();
  await page.waitForTimeout(500);
  expect(loads).toBe(0);

  release();
  await loaded;
  await page.unroute('**/api/media');
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  const flowForm = panel(page).group('Flow').locator('form.artifact-comment-form');
  await expect(flowForm.locator('textarea[name="text"]')).toHaveValue('Not sent yet');
  await expect(flowForm.locator('.artifact-attach-item img')).toHaveCount(1);
  await expect(flowForm.locator('.artifact-attach-item--loading')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('without crypto.subtle, an image spot\'s crop still uploading over Reload is not kept as an image', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-kept-crop-${test.info().repeatEachIndex}`;
  publish(name, doc());
  // As on a page served over plain HTTP: the crop is found among the
  // composer's images once uploaded, not by its hash.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined, configurable: true });
  });
  const errors = await watch(page);
  await load(page, name);
  const fish = figure(page);
  await fish.img.scrollIntoViewIfNeeded();
  await expect.poll(() => fish.img.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  let release!: () => void;
  const released = new Promise<void>((done) => { release = done; });
  await page.route('**/api/media', async (route) => {
    await released;
    await route.continue();
  });
  await fish.comment.click();
  const shown = await rect(fish.img);
  await drag(page, [shown.x + shown.width * 0.2, shown.y + shown.height * 0.25],
    [shown.x + shown.width * 0.6, shown.y + shown.height * 0.7]);
  const form = composer(page);
  await form.field.fill('Not sent yet');
  await expect(page.locator('.artifact-attach-item--loading')).toHaveCount(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  });
  const [head, flowPart, pictures] = doc().split(/(?=## Flow|## Pictures)/);
  publish(name, head + pictures + '\n' + flowPart);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const reload = page.locator('.artifact-live-page-banner').getByRole('button', { name: 'Reload' });
  await expect(reload).toBeVisible();

  const fetched = page.waitForResponse((response) => new URL(response.url()).pathname === `/${name}.html` &&
    response.request().resourceType() === 'fetch');
  const loaded = page.waitForEvent('load');
  await reload.click();
  await fetched;
  release();
  await loaded;
  await page.unroute('**/api/media');
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  const picturesForm = panel(page).group('Pictures').locator('form.artifact-comment-form');
  await expect(picturesForm.locator('textarea[name="text"]')).toHaveValue('Not sent yet');
  await expect(picturesForm.locator('.artifact-attach-item')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('marks on adjacent diagrams are numbered in page order, and a draft\'s composer follows a wide diagram\'s scroll', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-adjacent-${test.info().repeatEachIndex}`;
  const chain = Array.from({ length: 16 }, (_, i) => `Step${i + 1}`).join(' --> ');
  publish(name, ['# Spot pair', '', 'Two drawings, one after the other.', '', '## Flow', '', 'Both of them.', '',
    '```mermaid id=upper', 'graph LR', '  Agent --> Pod', '```', '',
    // Drawn at its own width, it scrolls sideways in its pre.
    '```mermaid id=wide', '%%{init: {"flowchart": {"useMaxWidth": false}}}%%', 'graph LR', `  ${chain}`, '```', ''].join('\n'));
  const errors = await watch(page);
  await page.goto(`/${name}.html?standalone`);
  const pre = (id: string) => page.locator(`pre.mermaid[data-spot="${id}"]`);
  const node = (id: string, label: string) => pre(id).locator(`g.node[id^="flowchart-${label}-"]`);
  await expect(pre('upper').locator(':scope > svg')).toBeVisible();
  await expect(pre('wide').locator(':scope > svg')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
  const form = composer(page);

  // The lower diagram's thread is posted first.
  for (const [id, label] of [['wide', 'Step1'], ['upper', 'Pod']]) {
    await pre(id).getByRole('button', { name: 'Comment', exact: true }).click();
    await node(id, label).click();
    await form.field.fill(`On ${label}`);
    const sent = posting(page);
    await form.send.click();
    await sent;
    await expect(form.holder).toHaveCount(0);
  }
  await page.reload();
  const badge = (id: string) => pre(id).locator('g.artifact-spot-mark:not(.artifact-spot-mark--draft) .artifact-spot-badge text');
  await expect(badge('upper')).toHaveText('1');
  await expect(badge('wide')).toHaveText('2');

  // The wide diagram scrolls inside its pre; the composer stays under its mark.
  const wide = pre('wide');
  expect(await wide.evaluate((el) => el.scrollWidth > el.clientWidth + 100)).toBe(true);
  await wide.getByRole('button', { name: 'Comment', exact: true }).click();
  await node('wide', 'Step2').click();
  await expect(form.holder).toHaveCount(1);
  const draft = wide.locator('g.artifact-spot-mark--draft .artifact-spot-shape');
  const gap = async () => (await rect(form.holder)).x - (await rect(draft)).x;
  const before = await gap();
  await wide.evaluate((el) => { el.scrollLeft = 100; });
  await expect.poll(async () => Math.abs((await gap()) - before)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('an archived page draws its image marks over the image', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-comments-archived-${test.info().repeatEachIndex}`;
  publish(name, doc());
  const errors = await watch(page);
  await load(page, name);
  const fish = figure(page);
  await fish.img.scrollIntoViewIfNeeded();
  await expect.poll(() => fish.img.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  await fish.comment.click();
  const shown = await rect(fish.img);
  await drag(page, [shown.x + shown.width * 0.2, shown.y + shown.height * 0.25], [shown.x + shown.width * 0.6, shown.y + shown.height * 0.7]);
  await post(page, 'The fin');
  expect(run('archive', name, '--local', '--out-dir', OUT)).toContain(`archived ${name}`);
  try {
    await load(page, name);
    await expect(page.locator('meta[name="lotuspod:archived"]')).toHaveCount(1);
    await expect(fish.comment).toHaveCount(0);
    await expect(fish.marks).toHaveCount(1);
    await fish.img.scrollIntoViewIfNeeded();
    const img = await rect(fish.img);
    const mark = await rect(fish.marks.first().locator('.artifact-spot-shape'));
    expect(mark.x).toBeGreaterThanOrEqual(img.x);
    expect(mark.y).toBeGreaterThanOrEqual(img.y);
    expect(mark.x + mark.width).toBeLessThanOrEqual(img.x + img.width);
    expect(mark.y + mark.height).toBeLessThanOrEqual(img.y + img.height);
  } finally {
    run('unarchive', name, '--local', '--out-dir', OUT);
  }
  expect(errors).toEqual([]);
});

test('a page that takes no comments has no Comment on its diagram or figure, and a drag draws nothing', async ({ page }) => {
  const name = `spot-comments-closed-${test.info().repeatEachIndex}`;
  publish(name, doc(), false);
  const errors = await watch(page);
  await page.goto(`/${name}.html?standalone`);
  const flow = diagram(page);
  await expect(flow.svg).toBeVisible();
  await expect(flow.pre.locator('.artifact-diagram-expand')).toHaveCount(1);
  await expect(flow.comment).toHaveCount(0);
  await expect(figure(page).comment).toHaveCount(0);
  const at = await rect(flow.svg);
  await drag(page, [at.x + 10, at.y + 10], [at.x + at.width / 2, at.y + at.height - 10]);
  await expect(page.locator('g.artifact-spot-mark, .artifact-spot-layer, .artifact-spot-composer')).toHaveCount(0);
  expect(errors).toEqual([]);
});
