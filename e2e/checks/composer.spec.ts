import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The comment composer as one box: the images attached sit as thumbnails
// above the field, inside the box, each with an X that removes it and a link
// that opens it in the image viewer; a + inside the box picks more. The
// checks render their own page into the capture fixture's site, so the
// threads they post are the only ones on it. At 1024 pixels a chip opens its
// section's threads in a popover, at 1440 in the panel and at 360 in a
// bottom sheet.
const MEDIUM = { width: 1024, height: 768 };
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 360, height: 740 };
test.use({ viewport: MEDIUM });

const NAME = 'check-composer';
const PAGE = `/${NAME}.html`;
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const FIXTURES = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'media');
const FISH = path.join(FIXTURES, 'fish-320x240.jpg');
const FROG = path.join(FIXTURES, 'frog-140x100.gif');
const LILY = path.join(FIXTURES, 'lily-lossy-240x160.webp');
const POND = path.join(FIXTURES, 'pond-progressive-300x200.jpg');
const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.png': 'image/png', '.webp': 'image/webp',
};
const BODY = `<p>A page for the composer checks.</p>
<h2>Pond</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice until the thaw.</p>
`;
const MEDIA_URL = /^\/media\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/;
const EXTENSIONS: Record<string, string> = { '.jpg': 'jpg', '.gif': 'gif', '.png': 'png', '.webp': 'webp' };
// What the site answers an upload of each fixture with, by its bytes' hash:
// its stored name is that hash, and its size is in its file name.
const STORED = new Map([FISH, FROG, LILY, POND].map((file) => {
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const [, width, height] = /-(\d+)x(\d+)/.exec(path.basename(file))!;
  const name = `${hash}.${EXTENSIONS[path.extname(file)]}`;
  return [hash, { name, url: `/media/${name}`, width: Number(width), height: Number(height) }];
}));

type Violation = { blockedURI: string; effectiveDirective: string };
type Rect = { top: number; bottom: number; left: number; right: number };

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  execFileSync(PYTHON, [
    '-m', 'lotuspod', 'render', '--name', NAME, '--title', 'Check composer', '--comments',
    '--body', BODY, '--out-dir', OUT,
  ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
});

// Console errors and policy violations, kept here so a reload keeps them.
async function watch(page: Page) {
  const errors: string[] = [];
  const violations: Violation[] = [];
  await page.exposeFunction('__violated', (violation: Violation) => { violations.push(violation); });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as any).__violated({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
    },
  };
}

// The run's one reader may make 20 uploads in any ten minutes (lotuspod.api's
// UPLOAD_LIMIT), and the other checks spend them; these answer the page's
// uploads as the site does for bytes it holds already. The capture fixture
// stores every fixture image for its images page, so the thumbnails and the
// comments naming them are the site's own.
async function stored(page: Page) {
  await page.route((url) => url.pathname === '/api/media', async (route) => {
    const hash = createHash('sha256').update(route.request().postDataBuffer() ?? Buffer.alloc(0)).digest('hex');
    const image = STORED.get(hash);
    expect(image, 'an upload of a fixture image').toBeTruthy();
    await route.fulfill({ status: 201, json: image });
  });
}

// A composer's parts, inside form.
function composer(form: Locator) {
  const box = form.locator('.artifact-composer-box');
  const tray = box.locator('ul.artifact-attach-tray');
  return {
    form,
    box,
    tray,
    items: tray.locator('li.artifact-attach-item'),
    links: tray.locator('a.artifact-attach-link'),
    removes: tray.locator('button.artifact-attach-remove'),
    field: box.locator('textarea[name="text"]'),
    add: box.getByRole('button', { name: 'Add image', exact: true }),
    status: form.locator('.artifact-comment-status'),
    send: form.locator('button[type="submit"]'),
  };
}

// A section's chip, and the popover it opens with its new thread's form.
function section(page: Page, name: string) {
  const details = page.locator(`details.artifact-comment[data-section="${name}"]`);
  const popover = page.locator('.artifact-comments-popover');
  return {
    summary: details.locator('summary'),
    popover,
    start: popover.getByRole('button', { name: 'Comment on this section' }),
    composer: composer(popover.locator('form.artifact-comment-form')),
  };
}

// Open a section's popover and its form for a new thread: unfolded at once
// when the section has no threads, else behind its button.
async function compose(page: Page, name: string) {
  const { summary, popover, start, composer: open } = section(page, name);
  await expect(summary).toHaveText(/ · /);
  const empty = (await summary.textContent())!.startsWith('No comments');
  await summary.click();
  await expect(popover).toBeVisible();
  if (!empty) await start.click();
  await expect(open.field).toBeFocused();
  return open;
}

async function thread(request: APIRequestContext, name: string, text: string) {
  const response = await request.post('/api/comments', {
    headers: SIGNED_IN,
    data: { page: NAME, section: name, text },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

// A thread's reply composer, unfolded.
async function reply(node: Locator) {
  await expect(node).toBeVisible();
  await node.getByRole('button', { name: 'Add to your comment' }).click();
  const open = composer(node.locator('form.artifact-comment-reply'));
  await expect(open.field).toBeFocused();
  return open;
}

async function pick(page: Page, button: Locator, files: string[]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(files);
}

// Paste image files into a field, as the clipboard hands them to the page.
async function paste(field: Locator, files: string[]) {
  const given = files.map((file) => ({
    name: path.basename(file),
    type: TYPES[path.extname(file)],
    base64: fs.readFileSync(file).toString('base64'),
  }));
  await field.evaluate((node, given) => {
    const data = new DataTransfer();
    for (const file of given) {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], file.name, { type: file.type }));
    }
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, given);
}

function rect(target: Locator): Promise<Rect> {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  });
}

// Every thumbnail lies inside the box and above its field.
async function aboveField(open: ReturnType<typeof composer>, count: number) {
  const images = open.links.locator('img');
  await expect(images).toHaveCount(count);
  await expect.poll(() => images.evaluateAll((nodes) =>
    nodes.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)),
  { timeout: 10_000 }).toBe(true);
  const box = await rect(open.box);
  const field = await rect(open.field);
  for (let i = 0; i < count; i += 1) {
    const thumb = await rect(open.links.nth(i).locator('img'));
    expect(thumb.left).toBeGreaterThanOrEqual(box.left);
    expect(thumb.right).toBeLessThanOrEqual(box.right);
    expect(thumb.top).toBeGreaterThanOrEqual(box.top);
    expect(thumb.bottom).toBeLessThanOrEqual(box.bottom);
    expect(thumb.bottom).toBeLessThan(field.top);
  }
}

async function srcs(open: ReturnType<typeof composer>) {
  return open.links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
}

// The outline a control draws with the focus on it.
function outline(target: Locator) {
  return target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
}

function focused(target: Locator) {
  return target.evaluate((node) => node === document.activeElement);
}

// Tab, or Shift+Tab, until the focus is on target.
async function tabTo(page: Page, target: Locator, key = 'Tab') {
  for (let i = 0; i < 12 && !(await focused(target)); i += 1) {
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('an empty composer is one box with its + inside, and Enter on the + opens the file chooser', async ({ page }) => {
    const seen = await watch(page);
    await stored(page);
    await page.goto(PAGE);
    const open = await compose(page, 'pond');
    await expect(open.box).toHaveCount(1);
    await expect(open.tray).toBeHidden();
    await expect(open.form.locator('button', { hasText: 'Add image' })).toHaveCount(0);
    await expect(open.add).toBeVisible();
    await expect(open.add).toHaveAttribute('type', 'button');
    await expect(open.add.locator('[aria-hidden="true"]')).toHaveText('+');
    // The send button and the status line stay after the box.
    await expect(open.box.locator('button[type="submit"], .artifact-comment-status')).toHaveCount(0);
    const add = await rect(open.add);
    const box = await rect(open.box);
    expect(add.left).toBeGreaterThanOrEqual(box.left);
    expect(add.bottom).toBeLessThanOrEqual(box.bottom);
    expect(add.top).toBeGreaterThan((await rect(open.field)).top);

    await page.keyboard.press('Tab');
    await expect(open.add).toBeFocused();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([FROG]);
    await aboveField(open, 1);
    await seen.clean();
  });

  test('two picked images sit inside the box above the field, each with its X, and one removed is not sent', async ({ page }) => {
    const seen = await watch(page);
    await stored(page);
    await page.goto(PAGE);
    const open = await compose(page, 'frogs');
    await pick(page, open.add, [FROG, LILY]);
    await aboveField(open, 2);
    await expect(open.removes).toHaveCount(2);
    await expect(open.removes.nth(0)).toHaveAccessibleName('Remove image 1 of 2');
    await expect(open.removes.nth(1)).toHaveAccessibleName('Remove image 2 of 2');
    await expect(open.form.locator('button', { hasText: 'Remove' })).toHaveCount(0);
    await expect(open.removes.nth(0).locator('[aria-hidden="true"]')).toHaveText('×');
    const [, kept] = await srcs(open);
    expect(kept).toMatch(MEDIA_URL);

    await open.removes.nth(0).click();
    await expect(open.items).toHaveCount(1);
    await expect(open.removes).toHaveAccessibleName('Remove image 1 of 1');
    await expect(open.field).toBeFocused();
    await expect(open.links).toHaveAttribute('href', kept!);

    await open.field.fill('Only the lily.');
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      open.send.click(),
    ]);
    expect(posted.status()).toBe(201);
    expect((await posted.json()).images.map((image: { url: string }) => image.url)).toEqual([kept]);
    await seen.clean();
  });

  test('Tab reaches the + and each X, and each draws a 2px solid outline', async ({ page }) => {
    const seen = await watch(page);
    await stored(page);
    await page.goto(PAGE);
    const open = await compose(page, 'pond');
    await pick(page, open.add, [FISH, FROG]);
    await expect(open.links.locator('img')).toHaveCount(2);
    await open.field.focus();

    await tabTo(page, open.add);
    expect(await outline(open.add)).toEqual({ style: 'solid', width: '2px' });
    await tabTo(page, open.removes.nth(1), 'Shift+Tab');
    expect(await outline(open.removes.nth(1))).toEqual({ style: 'solid', width: '2px' });
    await tabTo(page, open.links.nth(1), 'Shift+Tab');
    expect(await outline(open.links.nth(1))).toEqual({ style: 'solid', width: '2px' });
    await tabTo(page, open.removes.nth(0), 'Shift+Tab');
    expect(await outline(open.removes.nth(0))).toEqual({ style: 'solid', width: '2px' });
    await seen.clean();
  });

  test('a composer thumbnail opens in the image viewer, Next steps to the other, and Escape closes the viewer only', async ({ page }) => {
    const seen = await watch(page);
    await stored(page);
    await page.goto(PAGE);
    const { popover } = section(page, 'pond');
    const open = await compose(page, 'pond');
    await pick(page, open.add, [FISH, FROG]);
    await expect(open.links.locator('img')).toHaveCount(2);
    await open.field.fill('Which one is clearer?');
    const urls = await srcs(open);

    const dialog = page.locator('dialog.artifact-image-viewer');
    await open.links.nth(0).click();
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await expect(dialog.locator('img')).toHaveAttribute('src', urls[0]!);
    await expect(dialog.locator('figcaption')).toHaveText('Attached image 1 of 2');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.locator('img')).toHaveAttribute('src', urls[1]!);
    await dialog.getByRole('button', { name: 'Previous' }).click();
    await expect(dialog.locator('img')).toHaveAttribute('src', urls[0]!);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(popover).toBeVisible();
    await expect(open.field).toHaveValue('Which one is clearer?');
    await expect(open.items).toHaveCount(2);
    await expect(open.links.nth(0)).toBeFocused();
    await seen.clean();
  });

  test('the + is disabled at four images, and the + and each X while a comment saves', async ({ page }) => {
    const seen = await watch(page);
    await stored(page);
    await page.goto(PAGE);
    let open = await compose(page, 'frogs');
    await pick(page, open.add, [FISH, FROG, LILY, POND]);
    await expect(open.links.locator('img')).toHaveCount(4);
    await expect(open.add).toBeDisabled();
    await expect(open.removes.nth(3)).toHaveAccessibleName('Remove image 4 of 4');
    await open.removes.nth(3).click();
    await expect(open.add).toBeEnabled();
    await page.keyboard.press('Escape');

    await page.reload();
    open = await compose(page, 'pond');
    await pick(page, open.add, [FISH]);
    await expect(open.links.locator('img')).toHaveCount(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/comments', async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    await open.field.fill('Held while it saves.');
    const posted = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST');
    await open.send.click();
    await expect(open.status).toHaveText('Saving...');
    await expect(open.add).toBeDisabled();
    await expect(open.removes).toBeDisabled();
    release();
    expect((await posted).status()).toBe(201);
    await expect(open.items).toHaveCount(0);
    await seen.clean();
  });

  test('a reply composer in the side panel and a passage composer are each one box with the + inside', async ({ page, request }) => {
    const seen = await watch(page);
    await stored(page);
    const root = await thread(request, 'pond', 'Is the pump on a timer?');
    await page.setViewportSize(WIDE);
    await page.goto(PAGE);
    const aside = page.locator('aside.artifact-comments-panel');
    await page.locator('details.artifact-comment[data-section="pond"] summary').click();
    const node = aside.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    const replying = await reply(node);
    await expect(replying.box).toHaveCount(1);
    await expect(replying.add).toBeVisible();
    await expect(replying.tray).toBeHidden();
    await pick(page, replying.add, [FROG]);
    await aboveField(replying, 1);

    // Words selected in the text open the passage composer under the pill.
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.artifact-body')!, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
        const at = text.data.indexOf('frogs sleep');
        if (at < 0 || text.parentElement!.closest('details, form, aside')) continue;
        document.getSelection()!.setBaseAndExtent(text, at, text, at + 'frogs sleep'.length);
        return;
      }
    });
    const offer = page.locator('button.artifact-passage-pill');
    await expect(offer).toBeVisible();
    await offer.click();
    const passage = composer(page.locator('.artifact-passage-composer form.artifact-comment-form'));
    await expect(passage.field).toBeFocused();
    await expect(passage.box).toHaveCount(1);
    await expect(passage.add).toBeVisible();
    await pick(page, passage.add, [LILY]);
    await aboveField(passage, 1);
    await seen.clean();
  });

  test('at 360 pixels a reply composer with four images fits its bottom sheet', async ({ page, request }) => {
    const seen = await watch(page);
    await stored(page);
    const root = await thread(request, 'frogs', 'Do the frogs wake in March?');
    await page.setViewportSize(PHONE);
    await page.goto(PAGE);
    await page.locator('details.artifact-comment[data-section="frogs"] summary').click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    await expect(sheet).toBeVisible();
    await expect.poll(async () => Math.round((await rect(sheet)).bottom)).toBe(PHONE.height);
    const open = await reply(sheet.locator(`.artifact-comment-thread[data-thread="${root.id}"]`));
    await paste(open.field, [FISH, FROG, LILY, POND]);
    await aboveField(open, 4);

    const box = await rect(open.box);
    const held = await rect(sheet);
    expect(box.left).toBeGreaterThanOrEqual(held.left);
    expect(box.right).toBeLessThanOrEqual(held.right);
    const sideways = await sheet.evaluate((node) => {
      const scrolled = [node, ...node.querySelectorAll('*')].filter((each) => {
        const overflow = getComputedStyle(each).overflowX;
        return (overflow === 'auto' || overflow === 'scroll') && each.scrollWidth > each.clientWidth;
      });
      return scrolled.length;
    });
    expect(sideways).toBe(0);
    const fit = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
    await open.add.scrollIntoViewIfNeeded();
    await expect(open.add).toBeVisible();
    await expect(open.add).toBeInViewport();
    await expect(open.add).toBeDisabled();
    await seen.clean();
  });
});
