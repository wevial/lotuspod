import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The demo's live blocks in a real Chromium at 1280 px: the Try it page's
// block, with no library, runs beside the shim, its widget file answered
// with the sandbox policy, and a comment on its section gets demo-agent's
// scripted reply; the worked example's d3 chart redraws as its slider moves,
// with no console error or policy violation. jsDelivr is answered from the
// d3 installed under e2e/, as e2e/checks/libraries.spec.ts does, so no
// request leaves the machine.
const TRY_IT = '/try-it.html';
const EXAMPLE = '/interactive.html';
// The block sits under "The deep shelf", an h3 of "The pond today": the
// section a comment on it belongs to.
const SECTION = 'the-pond-today';
const SECTION_TITLE = 'The pond today';
const AGENT = 'demo-agent';
const REPLIES = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'demo', 'replies.json'), 'utf-8'));
const SANDBOX = "sandbox allow-scripts; frame-ancestors 'self'";
const JSDELIVR = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(d3)@[^/]+\/(.+)$/;
type Violation = { blockedURI: string; effectiveDirective: string };

// Answer jsDelivr's d3 from e2e/node_modules; the console errors, page errors
// and policy violations of the page and every frame in it.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as any).violations.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  await page.route(JSDELIVR, (route) => {
    const [, name, file] = JSDELIVR.exec(route.request().url())!;
    return route.fulfill({
      contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(path.resolve(__dirname, '..', 'node_modules', name, file)),
    });
  });
  return {
    errors,
    violations: async () => (await Promise.all(page.frames().map((frame) =>
      frame.evaluate(() => (window as any).violations as Violation[])))).flat(),
  };
}

test('the Try it block runs beside the shim, answered with the sandbox policy', async ({ page }) => {
  const seen = await watch(page);
  const widget = page.waitForResponse((response) => /\/try-it\.w-[0-9a-f]{12}\.html$/.test(new URL(response.url()).pathname));
  await page.goto(`${TRY_IT}?standalone`);
  const figure = page.locator(`figure.artifact-live[data-widget="deep-shelf"]`);
  await figure.scrollIntoViewIfNeeded();
  expect((await widget).headers()['content-security-policy']).toBe(SANDBOX);
  await expect(figure.locator('.artifact-live-badge')).toHaveText('Live');
  await expect(figure.locator('.artifact-live-title')).toHaveText('Lilies on the deep shelf');

  const frame = page.frameLocator('figure.artifact-live[data-widget="deep-shelf"] iframe');
  const verdict = frame.locator('#verdict');
  await expect(verdict).toHaveText('3 lilies get 1 m² each: room to spread.');
  await frame.locator('#lilies').fill('5');
  await expect(verdict).toHaveText('5 lilies get 0.6 m² each: the leaves will crowd and climb.');
  expect(await seen.violations()).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('a comment on the live block\'s section gets demo-agent\'s scripted reply', async ({ page }) => {
  await page.goto(`${TRY_IT}?standalone`);
  await expect(page.locator('details.artifact-comment > summary.artifact-comment-chip').first()).toBeAttached();
  await page.locator(`details.artifact-comment[data-section="${SECTION}"] > summary`).click();
  const group = page.locator('aside.artifact-comments-panel .artifact-comments-group')
    .filter({ has: page.locator('.artifact-comments-group-title', { hasText: SECTION_TITLE }) });
  await expect(group).toBeVisible();
  const start = group.getByRole('button', { name: 'Comment on this section' });
  if (await start.isVisible()) await start.click();
  const field = group.locator('form.artifact-comment-form textarea[name="text"]');
  const words = 'Could a fourth lily go on the shallow shelf?';
  await field.fill(words);
  await group.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(field).toHaveValue('');

  const thread = group.locator('.artifact-comments-entry').filter({ hasText: words });
  await expect(thread.locator('.artifact-comment-item--reader .artifact-comment-text')).toHaveText(words);
  const reply = thread.locator('.artifact-comment-item--agent');
  await expect(reply).toHaveCount(1, { timeout: 15_000 });
  await expect(reply.locator('.artifact-comment-handle')).toHaveText(AGENT);
  await expect(reply.locator('.artifact-comment-text')).toHaveText(REPLIES['try-it'][SECTION]);
});

test('the worked example\'s d3 chart redraws its marks as the slider moves, with no error', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`${EXAMPLE}?standalone`);
  const figure = page.locator('figure.artifact-live[data-widget="merge-churn"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure.locator('.artifact-live-badge')).toHaveText('Live');
  await expect(page.locator('form.artifact-decision')).toHaveCount(1);

  const frame = page.frameLocator('figure.artifact-live[data-widget="merge-churn"] iframe');
  await expect(frame.locator('rect.bar')).toHaveCount(8);
  await expect(frame.locator('rect.bar.selected')).toHaveAttribute('data-workers', '4');
  await expect(frame.locator('text.value')).toHaveText('23');
  await frame.locator('#workers').fill('6');
  await expect(frame.locator('rect.bar.selected')).toHaveAttribute('data-workers', '6');
  await expect(frame.locator('rect.bar.selected')).toHaveCount(1);
  await expect(frame.locator('text.value')).toHaveText('51');
  await expect(frame.locator('#reading')).toHaveText('With 6 workers: 35 merges a day, 51 rebases per 100 merges.');
  expect(await seen.violations()).toEqual([]);
  expect(seen.errors).toEqual([]);
});
