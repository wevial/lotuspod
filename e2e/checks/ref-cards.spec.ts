import { expect, test, type Locator, type Page } from '@playwright/test';

// The capture fixture's refs page (tests/capture_site.py), published with a
// refs file: its first paragraph names HOLO-175 (in review), HOLO-171
// (merged) and LOTUS-97 (in progress), its second relos#2266 and LOTUS-95,
// which the refs file lacks, and its last section HOLO-175 in code.
const PAGE = '/capture-refs.html';
// Signed in, as every reader behind Access is: a published page posts the
// revision it was opened at, which a signed-out request has refused.
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

function ref(page: Page, key: string): Locator {
  return page.locator(`.artifact-body button.artifact-ref[data-ref="${key}"]`);
}

function card(page: Page, id: string): Locator {
  return page.locator(`.artifact-ref-cards > .artifact-ref-card#${id}`);
}

function shown(page: Page): Locator {
  return page.locator('.artifact-ref-card:visible');
}

// Open the page and wait until the script has taken its references.
async function opened(page: Page) {
  const seen = await watch(page);
  await page.goto(PAGE);
  await expect(ref(page, 'HOLO-175')).toHaveClass(/artifact-ref--live/);
  return seen;
}

// Somewhere on the page that is no reference and no card.
async function away(page: Page) {
  await page.mouse.move(4, 400);
}

test('hovering a reference shows its card under it, and leaving hides it', async ({ page }) => {
  const seen = await opened(page);
  const holo = ref(page, 'HOLO-175');
  await holo.hover();
  await expect(shown(page)).toHaveCount(1);
  const shownCard = card(page, 'ref-holo-175');
  await expect(shownCard).toBeVisible();
  await expect(shownCard.locator('.artifact-ref-card-key')).toHaveText('Holophyte · HOLO-175');
  await expect(shownCard.locator('.artifact-ref-card-title'))
    .toHaveText('Story follow-ups become proposals');
  await expect(shownCard.locator('.artifact-ref-chip')).toHaveText('In review');
  await expect(shownCard.locator('a.artifact-ref-card-pr'))
    .toHaveAttribute('href', 'https://example.com/pr/475');
  await expect(shownCard.locator('.artifact-ref-card-asof')).toContainText('As of publish');
  await expect(holo).toHaveAttribute('aria-expanded', 'false');
  const under = await holo.boundingBox();
  const box = await shownCard.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(under!.y + under!.height);
  expect(Math.abs(box!.x - under!.x)).toBeLessThan(1);

  await away(page);
  await expect(shown(page)).toHaveCount(0);

  // Tab reaches relos#2266 and shows its card.
  const relos = ref(page, 'relos#2266');
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    if (await relos.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(relos).toBeFocused();
  await expect(shown(page)).toHaveCount(1);
  await expect(card(page, 'ref-relos-2266')).toBeVisible();
  await expect(card(page, 'ref-relos-2266').locator('.artifact-ref-card-title'))
    .toHaveText('Relay retries a dropped socket once');
  await seen.clean();
});

test('a click pins a card, and Esc, its ✕ or a click outside closes it', async ({ page }) => {
  const seen = await opened(page);
  const holo = ref(page, 'HOLO-175');
  const holoCard = card(page, 'ref-holo-175');
  const close = holoCard.locator('.artifact-ref-card-close');

  await holo.click();
  await expect(holo).toHaveAttribute('aria-expanded', 'true');
  await expect(close).toBeVisible();
  await expect(close).toHaveText('✕');
  await expect(holoCard.locator('.artifact-ref-card-asof')).toContainText('pinned, Esc closes');
  await away(page);
  await expect(holoCard).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(shown(page)).toHaveCount(0);
  await expect(holo).toBeFocused();
  await expect(holo).toHaveAttribute('aria-expanded', 'false');

  await holo.click();
  await expect(close).toBeVisible();
  await close.click();
  await expect(shown(page)).toHaveCount(0);
  await expect(holo).toBeFocused();

  await holo.click();
  await expect(holoCard).toBeVisible();
  await page.locator('h1.artifact-title').click();
  await expect(shown(page)).toHaveCount(0);

  // Pinned, a card gives way only to another reference's click.
  await holo.click();
  const merged = ref(page, 'HOLO-171');
  await merged.hover();
  await expect(shown(page)).toHaveCount(1);
  await expect(holoCard).toBeVisible();
  await merged.click();
  await expect(shown(page)).toHaveCount(1);
  await expect(card(page, 'ref-holo-171')).toBeVisible();
  await expect(merged).toHaveAttribute('aria-expanded', 'true');
  await expect(holo).toHaveAttribute('aria-expanded', 'false');

  // A second click unpins it: it then hides as the pointer leaves.
  await merged.click();
  await expect(merged).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, 'ref-holo-171').locator('.artifact-ref-card-close')).toBeHidden();
  await away(page);
  await expect(shown(page)).toHaveCount(0);
  await seen.clean();
});

test('a key the refs file lacks, or one in code, is plain text', async ({ page }) => {
  const seen = await opened(page);
  await expect(page.locator('button.artifact-ref[data-ref="LOTUS-95"]')).toHaveCount(0);
  await expect(page.locator('.artifact-body p', { hasText: 'LOTUS-95' }))
    .toHaveText('The relay fix is relos#2266, and LOTUS-95 is still only an idea.');
  await expect(page.locator('.artifact-body code', { hasText: 'HOLO-175' })).toHaveCount(1);
  await expect(page.locator('.artifact-body code button')).toHaveCount(0);
  await seen.clean();
});

test.describe('in a narrow window', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('the card of the reference nearest the right edge stays inside it', async ({ page }) => {
    const seen = await opened(page);
    const refs = page.locator('.artifact-body p', { hasText: 'The proposal work' })
      .locator('button.artifact-ref');
    const boxes = await refs.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { key: (node as HTMLElement).dataset.ref!, right: rect.right };
    }));
    expect(boxes.length).toBe(3);
    const rightmost = boxes.reduce((best, next) => (next.right > best.right ? next : best));
    const target = ref(page, rightmost.key);
    await target.click();
    await expect(shown(page)).toHaveCount(1);
    const box = await shown(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);

    const colors = await page.evaluate(() => {
      const resolve = (name: string) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const style = (id: string) =>
        getComputedStyle(document.querySelector(`#${id} .artifact-ref-chip`)!);
      const chip = (id: string) => style(id).borderTopColor;
      const surface = document.createElement('span');
      surface.style.backgroundColor = 'var(--color-surface)';
      document.body.appendChild(surface);
      const surfaceColor = getComputedStyle(surface).backgroundColor;
      surface.remove();
      return {
        review: [chip('ref-holo-175'), resolve('--color-amber')],
        merged: [chip('ref-holo-171'), resolve('--color-mint')],
        progress: [chip('ref-lotus-97'), resolve('--color-orchid')],
        // Waiting: border and text a hairline, on the surface.
        waitingBorder: [chip('ref-relos-2266'), resolve('--hairline-strong')],
        waitingText: [style('ref-relos-2266').color, resolve('--hairline-strong')],
        waitingGround: [style('ref-relos-2266').backgroundColor, surfaceColor],
      };
    });
    for (const [tone, [chip, token]] of Object.entries(colors)) {
      expect(chip, tone).toBe(token);
    }
    await seen.clean();
  });
});

test.describe('without the script', () => {
  test.use({ javaScriptEnabled: false });

  test('references read as plain text and no card shows', async ({ page }) => {
    await page.goto(PAGE);
    const paragraph = page.locator('.artifact-body p', { hasText: 'The proposal work' });
    await expect(paragraph).toHaveText('The proposal work in HOLO-175 builds on HOLO-171, which '
      + 'merged last week, and the cards in LOTUS-97 follow from both.');
    await ref(page, 'HOLO-175').hover();
    await expect(shown(page)).toHaveCount(0);
    await expect(page.locator('.artifact-ref-card')).toHaveCount(4);
    const [text, button] = await paragraph.evaluate((node) => [
      getComputedStyle(node).color,
      getComputedStyle(node.querySelector('button.artifact-ref')!).color,
    ]);
    expect(button).toBe(text);
  });
});
