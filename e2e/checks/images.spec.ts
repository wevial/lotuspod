import { expect, test, type Page } from '@playwright/test';

// The images page (tests/capture_site.py) is published from markdown with the
// fixture images beside its source. Each media response is held back, so a
// box the page did not reserve before the bytes arrive shows as a layout
// shift. Chromium's naturalWidth and naturalHeight are the independent check
// of the sizes lotuspod.media reads from each header.
const PAGE = '/capture-images.html';
const HOLD_MS = 500;

type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    const shifts: number[] = [];
    (window as any).__violations = seen;
    (window as any).__shifts = shifts;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) shifts.push((entry as any).value);
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/media/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });
  return {
    consoleErrors,
    violations: () => page.evaluate(() => (window as any).__violations as Violation[]),
    shifts: () => page.evaluate(() => (window as any).__shifts as number[]),
  };
}

for (const width of [1280, 360]) {
  test(`images keep their reserved boxes and the column at ${width} pixels wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const seen = await watch(page);
    await page.goto(PAGE);

    const images = page.locator('.artifact-body figure.artifact-figure img');
    await expect(images).toHaveCount(8);
    let widest = 0;
    for (let i = 0; i < 8; i += 1) {
      const image = images.nth(i);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
        timeout: 10_000,
      }).toBe(true);
      const sizes = await image.evaluate((img: HTMLImageElement) => {
        const body = img.closest('.artifact-body') as HTMLElement;
        const style = getComputedStyle(body);
        return {
          natural: [img.naturalWidth, img.naturalHeight],
          attributes: [Number(img.getAttribute('width')), Number(img.getAttribute('height'))],
          drawn: img.getBoundingClientRect().width,
          column: body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          scrollWidth: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        };
      });
      expect(sizes.natural).toEqual(sizes.attributes);
      expect(sizes.drawn).toBeLessThanOrEqual(sizes.column + 0.5);
      expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.viewport);
      if (sizes.attributes[0] > widest) widest = sizes.attributes[0];
    }
    expect(widest).toBe(1600);

    // The turned JPEG is drawn upright: taller than it is wide.
    const turned = page.getByRole('img', { name: 'A turned photo' });
    expect(await turned.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([96, 160]);

    // The widest image is capped at the column and keeps its ratio.
    const chart = page.getByRole('img', { name: 'Pump hours per month' });
    const box = await chart.boundingBox();
    expect(box!.width).toBeLessThan(1600);
    expect(Math.abs(box!.height - (box!.width * 600) / 1600)).toBeLessThan(1);

    expect(await seen.shifts()).toEqual([]);
    expect(await seen.violations()).toEqual([]);
    expect(seen.consoleErrors).toEqual([]);
  });
}

// A plain click opens the image viewer (image-viewer.spec.ts).
test('clicking an image with the platform modifier opens its media URL', async ({ page, context }) => {
  const seen = await watch(page);
  await page.goto(PAGE);
  const fish = page.getByRole('img', { name: 'A fish in the pond' });
  const src = await fish.getAttribute('src');
  expect(src).toMatch(/^\/media\/[0-9a-f]{64}\.jpg$/);

  const [response] = await Promise.all([
    context.waitForEvent('response', (r) => r.url().endsWith(src!) && r.request().isNavigationRequest()),
    fish.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/jpeg');
  expect(seen.consoleErrors).toEqual([]);
});
