import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

// Comments on a spot where comments use the bottom sheet, and by keyboard on
// an image. The check publishes pages of its own as hermes on the capture
// fixture's site with a real `lotuspod publish`: a section Flow drawing the
// flowchart `flow` (Agent, Publish, Pod, Reader), and a section Pictures with
// the fixture's fish. At 390 by 844 with touch, a target's Comment opens the
// diagram view or the image viewer in mark mode, one finger draws and two
// pinch; the posted thread opens in the bottom sheet. The run shares one
// database, so each repeat publishes pages of its own names.
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
const PHONE = { width: 390, height: 844 };

test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

// The page polls /api/comments; a poll still in a route handler's route.fetch
// when a check ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Flow's flowchart and the fish under Pictures, with text enough round them
// that the page scrolls at either size.
const DOC = ['# Spot study', '', 'Where a comment on a drawing lands.', '',
  '## Flow', '', 'How a page reaches its reader.', '',
  '```mermaid id=flow', 'graph LR', '  Agent --> Publish --> Pod --> Reader', '```', '',
  ...Array.from({ length: 6 }, (_, n) => `Paragraph ${n + 1} on how a page is published, served and read by its readers.\n`),
  '## Pictures', '', 'The pond as it is.', '', '![Fish](fish.jpg)', '',
  ...Array.from({ length: 6 }, (_, n) => `Note ${n + 1} on the pond, its fish and the weeds along its edge.\n`)].join('\n');

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string) {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-spot-narrow-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, DOC, 'utf-8');
    fs.copyFileSync(FISH, path.join(dir, 'fish.jpg'));
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments');
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
  return {
    pre,
    svg: pre.locator(':scope > svg'),
    comment: pre.getByRole('button', { name: 'Comment', exact: true }),
    expand: pre.getByRole('button', { name: 'Expand diagram' }),
  };
}

function figure(page: Page) {
  const node = page.locator('figure.artifact-figure').filter({ has: page.locator('img[alt="Fish"]') });
  return {
    node, img: node.locator('img'),
    comment: node.getByRole('button', { name: 'Comment', exact: true }),
    surface: node.locator('svg.artifact-spot-overlay'),
  };
}

// The diagram view, with what mark mode puts in it.
function view(page: Page) {
  const dialog = page.locator('dialog.artifact-diagram-view');
  const named = (name: string) => dialog.getByRole('button', { name, exact: true });
  return {
    dialog,
    readout: dialog.locator('.artifact-diagram-view-readout'),
    stage: dialog.locator('.artifact-diagram-view-stage'),
    zoomIn: dialog.getByRole('button', { name: 'Zoom in' }),
    box: named('Box'),
    marks: dialog.locator('g.artifact-spot-mark:not(.artifact-spot-mark--draft)'),
    draft: dialog.locator('g.artifact-spot-mark--draft'),
    node: (id: string) => dialog.locator(`g.node[id^="flowchart-${id}-"]`),
    // A node's drawn box: its shape, without its label, whose text the
    // browser sets anew at each size.
    shape: (id: string) => dialog.locator(`g.node[id^="flowchart-${id}-"] > .label-container`),
  };
}

function viewer(page: Page) {
  const dialog = page.locator('dialog.artifact-image-viewer');
  return {
    dialog,
    image: dialog.locator('img.artifact-image-viewer-image'),
    box: dialog.getByRole('button', { name: 'Box', exact: true }),
    draft: dialog.locator('g.artifact-spot-mark--draft'),
    posted: dialog.locator('g.artifact-spot-mark[data-thread]'),
  };
}

function composer(page: Page) {
  const holder = page.locator('.artifact-spot-composer');
  return {
    holder,
    field: holder.locator('textarea[name="text"]'),
    send: holder.getByRole('button', { name: 'Comment', exact: true }),
  };
}

function sheet(page: Page) {
  const node = page.locator('.artifact-comments-bottom-sheet');
  return { node, entry: (text: string) => node.locator('.artifact-comments-entry').filter({ hasText: text }) };
}

// Load a page on its own; once its diagram is drawn and its threads read.
async function load(page: Page, name: string) {
  await page.goto(`/${name}.html?standalone`);
  await expect(diagram(page).svg).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-lotuspod-comments-read', '');
}

// The comment the page posts next, as the route receives it.
function posting(page: Page): Promise<Request> {
  return page.waitForRequest((request) => new URL(request.url()).pathname === '/api/comments' &&
    request.method() === 'POST' && 'text' in (request.postDataJSON() ?? {}));
}

// Type text in the open composer and send it with a tap; the request's body.
async function post(page: Page, text: string) {
  const form = composer(page);
  await expect(form.field).toBeVisible();
  await form.field.fill(text);
  const sent = posting(page);
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/comments' &&
    response.request().method() === 'POST');
  await form.send.tap();
  const body = (await sent).postDataJSON();
  expect((await answered).status()).toBe(201);
  await expect(form.holder).toHaveCount(0);
  return body;
}

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

// An svg shape's box on the screen, as drawn: its geometry, without the line
// round it, which keeps its width in px at any zoom.
async function drawnBox(locator: Locator) {
  return locator.first().evaluate((shape: SVGGraphicsElement) => {
    const box = shape.getBBox();
    const matrix = shape.getScreenCTM()!;
    const corner = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(matrix);
    const from = corner(box.x, box.y);
    const to = corner(box.x + box.width, box.y + box.height);
    return { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
  });
}

async function zoom(page: Page) {
  const text = (await view(page).readout.textContent()) ?? '';
  expect(text).toMatch(/^\d+%$/);
  return parseInt(text, 10);
}

function scrolled(page: Page) {
  return page.evaluate(() => window.scrollY);
}

// A CDP session's touches, as diagram-view.spec.ts sends them: Playwright
// has no pinch of its own.
async function touches(page: Page) {
  const session = await page.context().newCDPSession(page);
  async function send(type: string, points: { x: number; y: number }[]) {
    await session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id })),
    });
  }
  return {
    send,
    // Move the fingers from where they go down to where they lift.
    async gesture(from: { x: number; y: number }[], to: { x: number; y: number }[], steps = 8) {
      await send('touchStart', from);
      for (let at = 1; at <= steps; at += 1) {
        await send('touchMove', from.map((point, index) => ({
          x: point.x + (to[index].x - point.x) * at / steps,
          y: point.y + (to[index].y - point.y) * at / steps,
        })));
      }
      await send('touchEnd', []);
      // Chromium's gesture detector drops a tap sent the instant a touch
      // sequence ends, which no finger can do; a finger's pause comes first.
      await page.waitForTimeout(400);
    },
  };
}

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE });

  test("the diagram's Comment marks in the view: one finger draws, two pinch, and the thread opens in the sheet", async ({ page }) => {
    test.setTimeout(120_000);
    const name = `spot-narrow-diagram-${test.info().repeatEachIndex}`;
    publish(name);
    const errors = await watch(page);
    await load(page, name);
    const flow = diagram(page);
    const shown = view(page);
    const fingers = await touches(page);

    // Not in mark mode, a swipe up over the diagram scrolls the page.
    await flow.pre.evaluate((pre) => pre.scrollIntoView({ block: 'center' }));
    const at = await rect(flow.svg);
    const before = await scrolled(page);
    const middle = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    await fingers.gesture([middle], [{ x: middle.x, y: middle.y - 200 }]);
    await expect.poll(() => scrolled(page)).toBeGreaterThan(before);

    // Comment opens the view in mark mode, Box pressed.
    await flow.pre.evaluate((pre) => pre.scrollIntoView({ block: 'center' }));
    await flow.comment.tap();
    await expect(shown.dialog).toBeVisible();
    await expect(shown.box).toHaveAttribute('aria-pressed', 'true');
    await expect(shown.node('Pod')).toBeVisible();

    // Two fingers pinch outwards: the view zooms, and nothing is drawn.
    const posts: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/comments' && request.method() === 'POST') posts.push(request.url());
    });
    const stage = await rect(shown.stage);
    const centre = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
    const zoomed = await zoom(page);
    await fingers.gesture([{ x: centre.x - 30, y: centre.y }, { x: centre.x + 30, y: centre.y }],
      [{ x: centre.x - 70, y: centre.y }, { x: centre.x + 70, y: centre.y }]);
    expect(await zoom(page)).toBeGreaterThan(zoomed);
    await expect(shown.draft).toHaveCount(0);
    await expect(composer(page).holder).toHaveCount(0);
    expect(posts).toEqual([]);

    // A second finger joining one that has begun to draw pinches from where
    // both now are: the view zooms in, and what the first drew goes.
    const drawing = await zoom(page);
    const one = (x: number) => [{ x, y: centre.y }];
    await fingers.send('touchStart', one(centre.x - 120));
    for (let at = 1; at <= 10; at += 1) await fingers.send('touchMove', one(centre.x - 120 + 10 * at));
    const both = (left: number, right: number) => [{ x: left, y: centre.y }, { x: right, y: centre.y }];
    await fingers.send('touchStart', both(centre.x - 20, centre.x + 80));
    for (let at = 1; at <= 4; at += 1) await fingers.send('touchMove', both(centre.x - 20 - 3 * at, centre.x + 80 + 3 * at));
    await fingers.send('touchEnd', []);
    await page.waitForTimeout(400);
    expect(await zoom(page)).toBeGreaterThan(drawing);
    await expect(shown.draft).toHaveCount(0);
    await expect(composer(page).holder).toHaveCount(0);
    expect(posts).toEqual([]);

    // One finger draws a box round Pod: the page holds still, and the
    // composer opens in the view under the mark.
    await shown.dialog.getByRole('button', { name: 'Fit', exact: true }).tap();
    const pod = await rect(shown.node('Pod'));
    const held = await scrolled(page);
    await fingers.gesture([{ x: pod.x - 10, y: pod.y - 10 }], [{ x: pod.x + pod.width + 10, y: pod.y + pod.height + 10 }]);
    expect(await scrolled(page)).toBe(held);
    await expect(shown.draft).toHaveCount(1);
    const form = composer(page);
    await expect(form.holder).toBeVisible();
    expect(await form.holder.evaluate((holder) => Boolean(holder.closest('dialog.artifact-diagram-view')))).toBe(true);
    const mark = await rect(shown.draft.locator('.artifact-spot-shape'));
    const under = await rect(form.holder);
    expect(under.y).toBeGreaterThanOrEqual(mark.y + mark.height);

    // A pinch with the composer open zooms the view and keeps the mark, the
    // composer and its text.
    await form.field.fill('Is this the pod?');
    const typed = await zoom(page);
    const high = { x: centre.x, y: stage.y + stage.height * 0.2 };
    await fingers.gesture([{ x: high.x - 30, y: high.y }, { x: high.x + 30, y: high.y }],
      [{ x: high.x - 70, y: high.y }, { x: high.x + 70, y: high.y }]);
    expect(await zoom(page)).toBeGreaterThan(typed);
    await expect(shown.draft).toHaveCount(1);
    await expect(form.field).toHaveValue('Is this the pod?');
    expect(posts).toEqual([]);

    // Posted: the spot names Pod, the view closes and the thread opens in the sheet.
    const body = await post(page, 'Is this the pod?');
    expect(body.spot.id).toBe('flow');
    expect(body.spot.shape.kind).toBe('box');
    expect(body.spot.nodes).toEqual([{ id: 'Pod', label: 'Pod' }]);
    await expect(shown.dialog).toBeHidden();
    await expect(sheet(page).node).toBeVisible();
    await expect(sheet(page).entry('Is this the pod?')).toBeVisible();

    // In the view, the posted mark grows with Pod as the view zooms in.
    await sheet(page).node.getByRole('button', { name: 'Close' }).first().tap();
    await expect(sheet(page).node).toBeHidden();
    await flow.pre.evaluate((pre) => pre.scrollIntoView({ block: 'center' }));
    await flow.expand.tap();
    await expect(shown.dialog).toBeVisible();
    await expect(shown.marks).toHaveCount(1);
    const shape = shown.marks.locator('.artifact-spot-shape');
    const fromMark = await drawnBox(shape);
    const fromPod = await drawnBox(shown.shape('Pod'));
    await shown.zoomIn.tap();
    await shown.zoomIn.tap();
    const toMark = await drawnBox(shape);
    const toPod = await drawnBox(shown.shape('Pod'));
    const factor = toPod.width / fromPod.width;
    expect(factor).toBeGreaterThan(1.2);
    expect(Math.abs(toPod.height - fromPod.height * factor)).toBeLessThanOrEqual(1);
    expect(Math.abs(toMark.width - fromMark.width * factor)).toBeLessThanOrEqual(1);
    expect(Math.abs(toMark.height - fromMark.height * factor)).toBeLessThanOrEqual(1);
    expect(toMark.x).toBeLessThanOrEqual(toPod.x);
    expect(toMark.y).toBeLessThanOrEqual(toPod.y);
    expect(toMark.x + toMark.width).toBeGreaterThanOrEqual(toPod.x + toPod.width);
    expect(toMark.y + toMark.height).toBeGreaterThanOrEqual(toPod.y + toPod.height);
    await expect(shown.marks.locator('.artifact-spot-badge')).toHaveText('1');
    expect(errors).toEqual([]);
  });

  test("the fish's Comment marks in the image viewer, and the thread opens in the sheet", async ({ page }) => {
    test.setTimeout(120_000);
    const name = `spot-narrow-image-${test.info().repeatEachIndex}`;
    publish(name);
    const errors = await watch(page);
    await load(page, name);
    const fish = figure(page);
    const shown = viewer(page);
    const fingers = await touches(page);
    await fish.img.evaluate((img) => img.scrollIntoView({ block: 'center' }));
    await expect.poll(() => fish.img.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);

    await fish.comment.tap();
    await expect(shown.dialog).toBeVisible();
    await expect(shown.box).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => shown.image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
    const image = await rect(shown.image);
    const held = await scrolled(page);
    await fingers.gesture([{ x: image.x + image.width * 0.2, y: image.y + image.height * 0.25 }],
      [{ x: image.x + image.width * 0.6, y: image.y + image.height * 0.7 }]);
    expect(await scrolled(page)).toBe(held);
    await expect(shown.draft).toHaveCount(1);
    await expect(composer(page).holder).toBeVisible();
    expect(await composer(page).holder.evaluate((holder) => Boolean(holder.closest('dialog.artifact-image-viewer')))).toBe(true);

    const body = await post(page, 'This fin');
    const shape = body.spot.shape;
    expect(body.spot.nodes).toEqual([]);
    expect(shape.kind).toBe('box');
    expect(shape.w).toBeGreaterThan(0);
    expect(shape.h).toBeGreaterThan(0);
    expect(shape.x + shape.w).toBeLessThanOrEqual(320);
    expect(shape.y + shape.h).toBeLessThanOrEqual(240);
    expect(shape.x).toBeCloseTo(64, -1);
    expect(shape.y).toBeCloseTo(60, -1);
    await expect(shown.dialog).toBeHidden();
    await expect(sheet(page).node).toBeVisible();
    await expect(sheet(page).entry('This fin')).toBeVisible();

    // The posted mark is drawn over the viewer's image in mark mode, numbered
    // as on the page. With a box drawn, Escape leaves mark mode with the
    // viewer open, the mark going back to the page, and a second closes it,
    // the focus back on the fish's Comment.
    await sheet(page).node.getByRole('button', { name: 'Close' }).first().tap();
    await fish.img.evaluate((img) => img.scrollIntoView({ block: 'center' }));
    await fish.comment.tap();
    await expect(shown.box).toBeVisible();
    await expect(shown.posted).toHaveCount(1);
    await expect(shown.posted.locator('.artifact-spot-badge text')).toHaveText('1');
    await expect(fish.node.locator('g.artifact-spot-mark[data-thread]')).toHaveCount(0);
    const again = await rect(shown.image);
    await fingers.gesture([{ x: again.x + again.width * 0.3, y: again.y + again.height * 0.3 }],
      [{ x: again.x + again.width * 0.5, y: again.y + again.height * 0.5 }]);
    await expect(composer(page).field).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(shown.box).toHaveCount(0);
    await expect(composer(page).holder).toHaveCount(0);
    await expect(shown.draft).toHaveCount(0);
    await expect(shown.dialog).toBeVisible();
    await expect(shown.posted).toHaveCount(0);
    await expect(fish.node.locator('g.artifact-spot-mark[data-thread]')).toHaveCount(1);
    await expect(fish.comment).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(shown.dialog).toBeHidden();
    await expect(fish.comment).toBeFocused();
    expect(errors).toEqual([]);
  });
});

test('the keyboard marks a box on an image: Enter drops it, the arrows move it and Shift resizes it', async ({ page }) => {
  test.setTimeout(120_000);
  const name = `spot-narrow-keys-${test.info().repeatEachIndex}`;
  publish(name);
  const errors = await watch(page);
  await load(page, name);
  const fish = figure(page);
  await fish.img.scrollIntoViewIfNeeded();
  await expect.poll(() => fish.img.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  await fish.comment.click();
  for (let n = 0; n < 6 && !(await fish.surface.evaluate((node) => node === document.activeElement).catch(() => false)); n++) {
    await page.keyboard.press('Tab');
  }
  await expect(fish.surface).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fish.node.locator('g.artifact-spot-mark--draft')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  const form = composer(page);
  await expect(form.field).toBeFocused();
  await page.keyboard.type('By keyboard');
  const sent = posting(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  const body = (await sent).postDataJSON();
  expect(body.spot.id).toBe(await fish.img.getAttribute('data-spot'));
  expect(body.spot.nodes).toEqual([]);
  expect(body.spot.shape).toEqual({ kind: 'box', x: 152, y: 90, w: 80, h: 72 });
  await expect(form.holder).toHaveCount(0);
  expect(errors).toEqual([]);
});
