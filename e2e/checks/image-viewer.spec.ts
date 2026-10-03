import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The image viewer: a page figure's image, or a comment's thumbnail, opens
// full size in a modal dialog over the page instead of leaving it. The
// figures are the images page's (tests/capture_site.py); the comment's images
// are posted to a page these checks render into the capture fixture's site.
const IMAGES = '/capture-images.html';
const NAME = 'check-image-viewer';
const PAGE = `/${NAME}.html`;
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const FIXTURES = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'media');
const BODY = `<p>A page for the image viewer checks.</p>
<h2>Pond</h2>
<p>The pond freezes in January.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice.</p>
`;
const MEDIA_URL = /^\/media\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

type Violation = { blockedURI: string; effectiveDirective: string };

// Every console message of any type, uncaught errors and policy violations,
// kept here so a new page's are too.
async function watch(page: Page) {
  const messages: string[] = [];
  const violations: Violation[] = [];
  await page.exposeFunction('__violated', (violation: Violation) => { violations.push(violation); });
  page.on('console', (message) => { messages.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as any).__violated({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    async clean() {
      expect(messages).toEqual([]);
      expect(violations).toEqual([]);
    },
  };
}

function viewer(page: Page) {
  const dialog = page.locator('dialog.artifact-image-viewer');
  return {
    dialog,
    image: dialog.locator('img'),
    caption: dialog.locator('figcaption'),
    close: dialog.getByRole('button', { name: 'Close' }),
    previous: dialog.getByRole('button', { name: 'Previous' }),
    next: dialog.getByRole('button', { name: 'Next' }),
    original: dialog.getByRole('link', { name: 'Open original' }),
  };
}

// A figure's link, around its image named alt.
function figure(page: Page, alt: string) {
  return page.locator('.artifact-body figure.artifact-figure a').filter({
    has: page.getByRole('img', { name: alt, exact: true }),
  });
}

async function isModal(dialog: Locator) {
  return dialog.evaluate((node) => node.matches(':modal'));
}

async function focusInside(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog.artifact-image-viewer');
    return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement)
      && document.activeElement !== dialog);
  });
}

test.describe('a page figure', () => {
  test('a click opens the image in a modal dialog, captioned and fit to the window, and the page stays', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(IMAGES);
    const url = page.url();
    const view = viewer(page);

    for (const [alt, size] of [['Pump hours per month', [1600, 600]], ['A fish in the pond', [320, 240]]] as const) {
      const link = figure(page, alt);
      const src = await link.locator('img').getAttribute('src');
      expect(src).toMatch(MEDIA_URL);
      await link.click();

      await expect(view.dialog).toBeVisible();
      expect(page.url()).toBe(url);
      expect(await isModal(view.dialog)).toBe(true);
      await expect(page.getByRole('dialog', { name: alt, exact: true })).toBeVisible();
      await expect(view.caption).toHaveText(alt);
      await expect(view.image).toHaveAttribute('src', src!);
      await expect.poll(() => view.image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(size[0]);
      const box = await view.image.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(1280);
      expect(box!.height).toBeLessThanOrEqual(720);
      // At its natural size where it fits, scaled down keeping its ratio
      // where it does not.
      expect(box!.width).toBeCloseTo(Math.min(size[0], (size[0] * box!.height) / size[1]), 0);
      if (size[0] <= 1280) expect(box!.width).toBeCloseTo(size[0], 0);
      else expect(box!.width).toBeLessThan(size[0]);
      await expect(view.original).toHaveAttribute('href', src!);
      await expect(view.previous).toBeHidden();
      await expect(view.next).toBeHidden();

      await view.close.click();
      await expect(view.dialog).toBeHidden();
    }
    await seen.clean();
  });

  test('Escape, Close and a click on the backdrop each close it, and the focus is back on the image', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(IMAGES);
    const view = viewer(page);
    const link = figure(page, 'A fish in the pond');
    const closers: [string, () => Promise<void>][] = [
      ['Escape', () => page.keyboard.press('Escape')],
      ['Close', () => view.close.click()],
      ['backdrop', () => page.mouse.click(5, 5)],
    ];
    for (const [how, close] of closers) {
      await link.click();
      await expect(view.dialog, how).toBeVisible();
      await close();
      await expect(view.dialog, how).toBeHidden();
      await expect(link, how).toBeFocused();
    }
    await seen.clean();
  });

  test('Tab reaches the image, Enter opens it, and Tab stays in the dialog until it closes', async ({ page }) => {
    const seen = await watch(page);
    await page.goto(IMAGES);
    const view = viewer(page);
    const link = figure(page, 'A fish in the pond');
    const linked = () => link.evaluate((node) => node === document.activeElement);
    for (let i = 0; i < 60 && !(await linked()); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(link).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(view.dialog).toBeVisible();
    expect(await isModal(view.dialog)).toBe(true);
    expect(await focusInside(page)).toBe(true);
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await focusInside(page), key).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(view.dialog).toBeHidden();
    await expect(link).toBeFocused();
    await seen.clean();
  });

  test('a click with the platform modifier opens the original in a new page, not the viewer', async ({ page, context }) => {
    const seen = await watch(page);
    await page.goto(IMAGES);
    const url = page.url();
    const link = figure(page, 'A fish in the pond');
    const src = await link.locator('img').getAttribute('src');
    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      link.click({ modifiers: ['ControlOrMeta'] }),
    ]);
    await opened.waitForLoadState();
    expect(new URL(opened.url()).pathname).toBe(src);
    await opened.close();
    await expect(viewer(page).dialog).toHaveCount(0);
    expect(page.url()).toBe(url);
    await seen.clean();
  });

  test('Open original opens the image in a new page', async ({ page, context }) => {
    const seen = await watch(page);
    await page.goto(IMAGES);
    const view = viewer(page);
    const link = figure(page, 'A fish in the pond');
    const src = await link.locator('img').getAttribute('src');
    await link.click();
    await expect(view.dialog).toBeVisible();
    const [opened] = await Promise.all([context.waitForEvent('page'), view.original.click()]);
    await opened.waitForLoadState();
    expect(new URL(opened.url()).pathname).toBe(src);
    expect(await opened.evaluate(() => {
      const img = document.querySelector('img');
      return img ? [img.naturalWidth, img.naturalHeight] : null;
    })).toEqual([320, 240]);
    await opened.close();
    await expect(view.dialog).toBeVisible();
    await seen.clean();
  });
});

test.describe('a comment\'s images', () => {
  test.use({ viewport: { width: 1024, height: 768 }, extraHTTPHeaders: SIGNED_IN });

  test.beforeAll(() => {
    for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    execFileSync(PYTHON, [
      '-m', 'lotuspod', 'render', '--name', NAME, '--title', 'Check image viewer', '--comments',
      '--body', BODY, '--out-dir', OUT,
    ], { env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  });

  async function upload(request: APIRequestContext, file: string, type: string) {
    const response = await request.post('/api/media', {
      headers: { ...SIGNED_IN, 'Content-Type': type },
      data: fs.readFileSync(path.join(FIXTURES, file)),
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as { name: string; url: string };
  }

  test('a thumbnail opens its image, and Previous and Next step between the comment\'s images', async ({ page, request }) => {
    const seen = await watch(page);
    const images = [
      await upload(request, 'fish-320x240.jpg', 'image/jpeg'),
      await upload(request, 'frog-140x100.gif', 'image/gif'),
      await upload(request, 'lily-lossy-240x160.webp', 'image/webp'),
    ];
    const posted = await request.post('/api/comments', {
      headers: SIGNED_IN,
      data: { page: NAME, section: 'pond', text: 'Three pictures of the pond.', images: images.map((image) => image.name) },
    });
    expect(posted.status()).toBe(201);
    const row = await posted.json();

    await page.goto(PAGE);
    const url = page.url();
    await page.locator('details.artifact-comment[data-section="pond"] summary').click();
    const popover = page.locator('.artifact-comments-popover');
    await expect(popover).toBeVisible();
    const thumbs = popover.locator(`.artifact-comment-thread[data-thread="${row.id}"] a.artifact-comment-image`);
    await expect(thumbs).toHaveCount(3);

    const view = viewer(page);
    await thumbs.nth(1).click();
    await expect(view.dialog).toBeVisible();
    expect(page.url()).toBe(url);
    expect(await isModal(view.dialog)).toBe(true);
    // Captioned and named by the thumbnail's own alt text.
    const alts = await thumbs.locator('img').evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).alt));
    expect(alts[1]).toBe('Image 2 of 3, opens full size');
    await expect(page.getByRole('dialog', { name: alts[1], exact: true })).toBeVisible();
    await expect(view.caption).toHaveText(alts[1]);
    await expect(view.image).toHaveAttribute('src', images[1].url);
    await expect(view.original).toHaveAttribute('href', images[1].url);

    await view.next.click();
    await expect(view.image).toHaveAttribute('src', images[2].url);
    await expect(view.caption).toHaveText(alts[2]);
    await expect(page.getByRole('dialog', { name: alts[2], exact: true })).toBeVisible();
    await expect(view.original).toHaveAttribute('href', images[2].url);
    await view.previous.click();
    await expect(view.image).toHaveAttribute('src', images[1].url);
    await view.previous.click();
    await expect(view.image).toHaveAttribute('src', images[0].url);
    await expect(view.caption).toHaveText(alts[0]);
    await expect.poll(() => view.image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);

    // Escape closes the viewer, never the thread's popover under it.
    await page.keyboard.press('Escape');
    await expect(view.dialog).toBeHidden();
    await expect(popover).toBeVisible();
    await expect(thumbs.nth(1)).toBeFocused();
    await seen.clean();
  });
});
