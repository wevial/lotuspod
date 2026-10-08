import { expect, test, type Locator, type Page } from '@playwright/test';

// The capture fixture's decision context page: a decisions table with a
// Context column. Decision 1's context, which holds a link to the sample
// article, shows unlabelled under its question and wraps on a phone;
// decision 2's is empty and shows nothing. Nothing here writes an answer.
const PAGE = '/capture-decision-context.html';
const ASSERTION = process.env.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const CONTEXT = 'A floating pump rides the ice, and a submerged one stays clear of it. '
  + 'See the pump notes before choosing, because the outlet only takes one of them '
  + 'without a new fitting.';

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
    errors,
    violations: () => page.evaluate(() => (window as any).__violations as Violation[]),
  };
}

function decision(page: Page, question: string) {
  const form = page.locator(`form.artifact-decision[data-question="${question}"]`);
  return {
    form,
    legend: form.locator('legend'),
    context: form.locator('p.artifact-decision-context'),
    radios: form.locator('input[type="radio"][name="choice"]'),
  };
}

// The number of lines the element's text is laid out on.
async function lines(target: Locator) {
  return target.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
  });
}

async function fits(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 900 } });

  test('the context sits unlabelled between the question and its options, its link kept', async ({ page }) => {
    expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
    const seen = await watch(page);
    await page.goto(PAGE);
    const first = decision(page, 'decision-1');
    await expect(first.radios).toHaveCount(2);
    await expect(first.context).toHaveCount(1);
    await expect(first.context).toBeVisible();
    await expect(first.context).toHaveText(CONTEXT);
    await expect(first.form.locator('legend + p.artifact-decision-context')).toHaveCount(1);
    const link = first.context.getByRole('link', { name: 'the pump notes' });
    await expect(link).toHaveAttribute('href', 'capture-article.html');

    const legend = (await first.legend.boundingBox())!;
    const context = (await first.context.boundingBox())!;
    const option = (await first.radios.first().boundingBox())!;
    expect(context.y).toBeGreaterThanOrEqual(legend.y + legend.height - 1);
    expect(option.y).toBeGreaterThanOrEqual(context.y + context.height - 1);

    const second = decision(page, 'decision-2');
    await expect(second.radios).toHaveCount(2);
    await expect(second.context).toHaveCount(0);
    expect(seen.errors).toEqual([]);
    expect(await seen.violations()).toEqual([]);
  });

  test('at 360 pixels wide the context wraps and the page does not scroll sideways', async ({ page }) => {
    const seen = await watch(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(PAGE);
    const first = decision(page, 'decision-1');
    await expect(first.context).toBeVisible();
    await first.form.scrollIntoViewIfNeeded();
    expect(await lines(first.context)).toBeGreaterThan(1);
    await fits(page);
    expect(seen.errors).toEqual([]);
  });
});
