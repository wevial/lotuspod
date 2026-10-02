import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Images on a comment: pasted into a thread's reply field, picked with a
// new thread's Add image button, refused before sending, and drawn as
// thumbnails that open full size. The checks render their own page into the
// capture fixture's site, so the threads they post are the only ones on it.
// At this width a chip opens its section's threads in a popover.
const MEDIUM = { width: 1024, height: 768 };
test.use({ viewport: MEDIUM });

const NAME = 'check-attachments';
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
const LOGO = path.join(FIXTURES, 'logo.svg');
const HOLD_MS = 500;
const BODY = `<p>A page for the attachment checks.</p>
<h2>Pond</h2>
<p>The pond freezes in January.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice.</p>
`;
const MEDIA_URL = /^\/media\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

type Violation = { blockedURI: string; effectiveDirective: string };
type Shift = { value: number; at: number; recent: boolean };

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  execFileSync(PYTHON, [
    '-m', 'lotuspod', 'render', '--name', NAME, '--title', 'Check attachments', '--comments',
    '--body', BODY, '--out-dir', OUT,
  ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
});

// Console errors, policy violations, layout shifts and every upload sent.
// Violations are kept here, not in the page, so a reload keeps them too.
async function watch(page: Page) {
  const errors: string[] = [];
  const uploads: string[] = [];
  const violations: Violation[] = [];
  await page.exposeFunction('__violated', (violation: Violation) => { violations.push(violation); });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/media') uploads.push(request.method());
  });
  await page.addInitScript(() => {
    const w = window as any;
    w.__shifts = [] as Shift[];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__violated({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        w.__shifts.push({ value: entry.value, at: entry.startTime, recent: entry.hadRecentInput });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  return {
    errors,
    uploads,
    shifts: () => page.evaluate(() => (window as any).__shifts as Shift[]),
    async clean() {
      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
    },
  };
}

// A section's chip, and the popover it opens with the section's threads
// and its form for a new one.
function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  const popover = page.locator('.artifact-comments-popover');
  const form = popover.locator('form.artifact-comment-form');
  return {
    summary: details.locator('summary'),
    popover,
    form,
    start: popover.getByRole('button', { name: 'Comment on this section' }),
    text: form.locator('textarea[name="text"]'),
    add: form.getByRole('button', { name: 'Add image' }),
    status: form.locator('.artifact-comment-status'),
    comment: popover.getByRole('button', { name: 'Comment', exact: true }),
    threads: popover.locator('.artifact-comment-thread'),
  };
}

async function open(page: Page, section: string) {
  const { summary, popover } = box(page, section);
  if (await popover.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
  }
  await summary.click();
  await expect(popover).toBeVisible();
}

// Open a section's form for a new thread: unfolded at once when the
// section has no threads, else behind its button.
async function compose(page: Page, section: string) {
  const { summary, start, text } = box(page, section);
  await expect(summary).toHaveText(/ · /);
  const empty = (await summary.textContent())!.startsWith('No comments');
  await open(page, section);
  if (!empty) await start.click();
  await expect(text).toBeFocused();
}

// Paste files into a field, as the clipboard hands them to the page.
async function paste(field: Locator, files: { name: string; type: string; base64?: string; size?: number }[]) {
  await field.evaluate((node, given) => {
    const data = new DataTransfer();
    for (const file of given) {
      const bytes = file.base64 !== undefined
        ? Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
        : new Uint8Array(file.size!);
      data.items.add(new File([bytes], file.name, { type: file.type }));
    }
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, files);
}

async function pick(page: Page, button: Locator, files: string[]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(files);
}

async function thread(request: APIRequestContext, section: string, text: string) {
  const response = await request.post('/api/comments', {
    headers: SIGNED_IN,
    data: { page: NAME, section, text },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

// The largest upload the comments route reports.
async function capOf(request: APIRequestContext): Promise<number> {
  const response = await request.get(`/api/comments?page=${NAME}`, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  const cap = (await response.json()).maxImageBytes;
  expect(cap).toBeGreaterThan(0);
  return cap;
}

function fish() {
  return { name: 'fish.jpg', type: 'image/jpeg', base64: fs.readFileSync(FISH).toString('base64') };
}

async function natural(image: Locator) {
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
    timeout: 10_000,
  }).toBe(true);
  return image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('a pasted image is sent with a reply, drawn as a thumbnail and opens full size', async ({ page, context, request }) => {
    const seen = await watch(page);
    const root = await thread(request, 'pond', 'What does the ice look like?');
    await page.goto(PAGE);
    await open(page, 'pond');
    const node = page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    await expect(node).toBeVisible();
    await node.getByRole('button', { name: 'Add to your comment' }).click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    await expect(field).toBeFocused();

    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/media');
    await paste(field, [fish()]);
    const upload = await answered;
    expect(upload.status()).toBe(201);
    const stored = await upload.json();
    expect(stored).toMatchObject({ width: 320, height: 240 });
    expect(stored.url).toMatch(MEDIA_URL);
    const tray = node.locator('form.artifact-comment-reply .artifact-attach-item');
    await expect(tray).toHaveCount(1);
    await expect(tray.locator('img')).toHaveAttribute('src', stored.url);
    await expect(tray.getByRole('button', { name: 'Remove' })).toBeVisible();
    await field.fill('Like this.');
    await node.getByRole('button', { name: 'Send' }).click();

    const mine = node.locator('.artifact-comment-item--reader');
    await expect(mine).toHaveCount(2);
    const shown = async () => {
      const thumbs = mine.nth(1).locator('.artifact-comment-images a.artifact-comment-image');
      await expect(thumbs).toHaveCount(1);
      await expect(mine.nth(1).locator('.artifact-comment-text')).toHaveText('Like this.');
      await expect(thumbs).toHaveAttribute('href', stored.url);
      await expect(thumbs).toHaveAttribute('target', '_blank');
      expect(await natural(thumbs.locator('img'))).toEqual([320, 240]);
      return thumbs;
    };
    const thumbs = await shown();
    await expect(tray).toHaveCount(0);
    expect(seen.uploads).toEqual(['POST']);

    // The thumbnail's link opens the full-size image in a new page.
    const [full] = await Promise.all([context.waitForEvent('page'), thumbs.click()]);
    await full.waitForLoadState();
    expect(new URL(full.url()).pathname).toBe(stored.url);
    expect(await full.evaluate(() => {
      const img = document.querySelector('img');
      return img ? [img.naturalWidth, img.naturalHeight] : null;
    })).toEqual([320, 240]);
    await full.close();

    await page.reload();
    await open(page, 'pond');
    await expect(node).toBeVisible();
    await shown();
    expect(seen.uploads).toEqual(['POST']);
    await seen.clean();
  });

  test('two picked images start a thread whose thumbnails keep their boxes while their bytes arrive', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const frogs = box(page, 'frogs');
    await compose(page, 'frogs');
    await pick(page, frogs.add, [FROG, LILY]);
    const tray = frogs.form.locator('.artifact-attach-item');
    await expect(tray).toHaveCount(2);
    await expect(tray.locator('img')).toHaveCount(2);
    await expect(tray.getByRole('button', { name: 'Remove' })).toHaveCount(2);
    // A comment of images alone needs no words.
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      frogs.comment.click(),
    ]);
    expect(posted.status()).toBe(201);
    const row = await posted.json();
    expect(row.text).toBe('');
    expect(row.images.map((image: { width: number; height: number }) => [image.width, image.height]))
      .toEqual([[140, 100], [240, 160]]);
    const node = page.locator(`.artifact-comment-thread[data-thread="${row.id}"]`);
    const root = node.locator('.artifact-comment-item--reader').first();
    await expect(root.locator('.artifact-comment-images img')).toHaveCount(2);
    await expect(root.locator('.artifact-comment-text')).toBeHidden();
    expect(seen.uploads).toEqual(['POST', 'POST']);
    await seen.clean();

    // After a reload every image response is held back.
    const held = { count: 0 };
    await page.route('**/media/**', async (route) => {
      held.count += 1;
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      await route.continue();
    });
    // From the top: a reload that restores a scrolled page can move its
    // sections before its first paint, whatever its threads hold.
    await page.keyboard.press('Escape');
    await expect(frogs.popover).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.reload();
    await open(page, 'frogs');
    const images = node.locator('.artifact-comment-images img');
    await expect(images).toHaveCount(2);
    const before = await images.evaluateAll((nodes) => nodes.map((img) => {
      const box = img.getBoundingClientRect();
      return { complete: (img as HTMLImageElement).complete, size: [box.width, box.height] };
    }));
    expect(before.map((image) => image.complete)).toEqual([false, false]);
    expect(await natural(images.nth(0))).toEqual([140, 100]);
    expect(await natural(images.nth(1))).toEqual([240, 160]);
    const after = await images.evaluateAll((nodes) => nodes.map((img) => {
      const box = img.getBoundingClientRect();
      return [box.width, box.height];
    }));
    expect(before.map((image) => image.size)).toEqual(after);
    expect(after[0][0]).toBeGreaterThan(0);
    expect(held.count).toBe(2);
    expect(await seen.shifts()).toEqual([]);
    await seen.clean();
  });

  test('a file of another type or over the cap is refused before it is sent', async ({ page, request }) => {
    const seen = await watch(page);
    const cap = await capOf(request);
    await page.goto(PAGE);
    const pond = box(page, 'pond');
    await compose(page, 'pond');

    await pick(page, pond.add, [LOGO]);
    await expect(pond.status).toHaveText('logo.svg is not a PNG, JPEG, WebP or GIF image.');
    await paste(pond.text, [{ name: 'big.png', type: 'image/png', size: cap + 1 }]);
    await expect(pond.status).toHaveText(/^big\.png is over the .+ limit\.$/);
    await expect(pond.form.locator('.artifact-attach-item')).toHaveCount(0);
    expect(seen.uploads).toEqual([]);
    await seen.clean();
  });

  test('a file attached before the cap is read waits for it, and is checked against it', async ({ page, request }) => {
    const seen = await watch(page);
    const cap = await capOf(request);
    // The page's first read of the threads, which reports the cap, is held.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/api/comments', async (route) => {
      if (route.request().method() === 'GET') await released;
      await route.continue();
    });
    await page.goto(PAGE);
    const pond = box(page, 'pond');
    await compose(page, 'pond');
    await paste(pond.text, [{ name: 'big.png', type: 'image/png', size: cap + 1 }, fish()]);
    await expect(pond.status).toHaveText('Checking the size limit...');
    await page.waitForTimeout(300);
    expect(seen.uploads).toEqual([]);

    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/media');
    release();
    await expect(pond.status).toHaveText(/^big\.png is over the .+ limit\.$/);
    expect((await answered).status()).toBe(201);
    await expect(pond.form.locator('.artifact-attach-item img')).toHaveCount(1);
    expect(seen.uploads).toEqual(['POST']);
    await seen.clean();
  });

  test('a composer takes no image while its comment saves, and keeps those it sends', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const pond = box(page, 'pond');
    await compose(page, 'pond');
    const tray = pond.form.locator('.artifact-attach-item');
    await paste(pond.text, [fish()]);
    await expect(tray.locator('img')).toHaveCount(1);
    const attached = await tray.locator('img').getAttribute('src');

    // Hold the comment's save while the reader tries to attach more.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/comments', async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    await pond.text.fill('Only the fish.');
    const posted = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST');
    await pond.comment.click();
    await expect(pond.status).toHaveText('Saving...');
    await expect(pond.add).toBeDisabled();
    await expect(tray.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await paste(pond.text, [{ name: 'frog.gif', type: 'image/gif', base64: fs.readFileSync(FROG).toString('base64') }]);
    await expect(pond.status).toHaveText('Saving... Attach more images once the comment is saved.');
    await expect(tray).toHaveCount(1);
    expect(seen.uploads).toEqual(['POST']);
    release();

    const saved = await posted;
    expect(saved.status()).toBe(201);
    expect((await saved.json()).images.map((image: { url: string }) => image.url)).toEqual([attached]);
    await expect(pond.threads.filter({ hasText: 'Only the fish.' }).locator('.artifact-comment-images img')).toHaveCount(1);

    // The form for the next thread is empty, and takes an image again.
    await compose(page, 'pond');
    await expect(pond.text).toHaveValue('');
    await expect(tray).toHaveCount(0);
    await expect(pond.add).toBeEnabled();
    await paste(pond.text, [fish()]);
    await expect(tray.locator('img')).toHaveCount(1);
    expect(seen.uploads).toEqual(['POST', 'POST']);
    await seen.clean();
  });

  test('an image attached twice is attached once', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(PAGE);
    const pond = box(page, 'pond');
    await compose(page, 'pond');
    const tray = pond.form.locator('.artifact-attach-item');
    await paste(pond.text, [fish()]);
    await expect(tray.locator('img')).toHaveCount(1);
    await paste(pond.text, [fish()]);
    await expect(pond.status).toHaveText('fish.jpg is attached already.');
    await expect(tray).toHaveCount(1);
    expect(seen.uploads).toEqual(['POST', 'POST']);

    await pond.text.fill('The same fish, once.');
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      pond.comment.click(),
    ]);
    expect(posted.status()).toBe(201);
    expect((await posted.json()).images).toHaveLength(1);
    await seen.clean();
  });
});
