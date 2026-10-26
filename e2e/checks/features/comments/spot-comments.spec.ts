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
const QUESTION = 'Is this the pod?';

test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

// The page: Flow's flowchart laid out as layout says, its chain as given,
// and the fish under Pictures.
function doc(layout = 'LR', chain = 'Agent --> Publish --> Pod --> Reader') {
  const ids = chain.split(' --> ');
  return ['# Spot study', '', 'Where a comment on a drawing lands.', '',
    '## Flow', '', 'How a page reaches its reader.', '',
    '```mermaid id=flow', `graph ${layout}`, `  ${chain}`, '```', '',
    '### Nodes', '', '| Node | Title | Status |', '|---|---|---|',
    ...ids.map((id) => `| ${id} | The ${id.toLowerCase()} step | merged |`), '',
    '## Pictures', '', 'The pond as it is.', '', '![Fish](fish.jpg)', ''].join('\n');
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
  const shown = await rect(fish.img);
  const from: [number, number] = [shown.x + shown.width * 0.2, shown.y + shown.height * 0.25];
  const to: [number, number] = [shown.x + shown.width * 0.6, shown.y + shown.height * 0.7];
  await drag(page, from, to);
  const form = composer(page);
  // The crop is the composer's first image, once uploaded.
  await expect(form.holder.locator('a.artifact-attach-link').first()).toBeVisible();
  const { body, row } = await post(page, 'This fin');
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
