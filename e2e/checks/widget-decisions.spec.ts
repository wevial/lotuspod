import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// A page whose "Merge churn" section asks one question of its own, then,
// under a second decisions heading, a live block followed directly by a
// two-question decisions table, which is about the block; "Rollout" asks
// one more. Each check publishes its own page, as its answers stay saved.
const env = process.env;
const ASSERTION = env.LOTUSPOD_TEST_ASSERTION ?? '';
const BLOCK = 'Merge churn by worker count';
const COUNTER = `<style>body { padding: 16px; } output { display: block; font-size: 32px; }</style>
<p>Merges a day, counting.</p><output>1</output>
<script>let count = 1; setInterval(() => document.querySelector('output').textContent = String(++count), 300);</script>`;
const SOURCE = `# Merge plan

## Merge churn

The merge queue churns as workers are added.

### Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| queue | Keep one merge queue? | Yes / No | Yes |

### Decisions for the maintainer

\`\`\`html live title="${BLOCK}" id=churn height=200
${COUNTER}
\`\`\`

| # | Question | Options |
| --- | --- | --- |
| workers | How many workers next week? | Two / Four / Eight |
| cadence | Merge daily? | Yes / No |

## Rollout

### Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| rollout | Roll out this week? | Yes / No |
`;

function publish(name = `widget-decisions-${randomBytes(4).toString('hex')}`, source = SOURCE): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-decisions-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, source);
    execFileSync(env.LOTUSPOD_TEST_PYTHON!, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', env.LOTUSPOD_TEST_OUT!,
      '--owner', 'hermes', '--credential', env.LOTUSPOD_TEST_CREDENTIAL_HERMES!, '--comments'],
    { env: { ...env, PYTHONPATH: path.resolve(__dirname, '../../src') } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return name;
}

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function open(page: Page) {
  expect(ASSERTION, 'LOTUSPOD_TEST_ASSERTION names an assertion the site accepts').toBeTruthy();
  const name = publish();
  await page.goto(`/${name}.html?standalone`);
  const figure = page.locator('figure.artifact-live[data-widget="churn"]');
  await expect(figure.locator('.artifact-live-badge')).toHaveText('Live');
  await expect(page.locator('button.artifact-review-count')).toBeVisible();
  return {
    name,
    figure,
    link: figure.locator('a.artifact-live-decisions'),
    form: (question: string) => page.locator(`form.artifact-decision[data-question="${question}"]`),
  };
}

test.use({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': ASSERTION }, viewport: { width: 1280, height: 800 } });

test('the forms name the block, and its chrome jumps to the first of them', async ({ page }) => {
  const errors = watch(page);
  const the = await open(page);
  for (const question of ['decision-workers', 'decision-cadence']) {
    await expect(the.form(question)).toHaveAttribute('data-about', 'churn');
    await expect(the.form(question).locator('.artifact-decision-about')).toHaveText(`About: ${BLOCK}`);
  }
  for (const question of ['decision-queue', 'decision-rollout']) {
    await expect(the.form(question)).not.toHaveAttribute('data-about');
    await expect(the.form(question).locator('.artifact-decision-about')).toHaveCount(0);
  }
  await expect(the.link).toHaveText('2 decisions');
  await expect(the.link).toHaveAttribute('href', '#question=decision-workers');
  await expect(the.form('decision-workers')).not.toBeInViewport();
  await the.link.click();
  await expect(the.form('decision-workers')).toBeInViewport();
  await expect(the.form('decision-workers').locator('input').first()).toBeFocused();
  // Pressed again, from further down, once it is the address too.
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await the.link.click();
  await expect(the.form('decision-workers')).toBeInViewport();
  await expect(the.form('decision-workers').locator('input').first()).toBeFocused();
  expect(errors).toEqual([]);
});

test('the Respond panel lists the questions under the block, after their section', async ({ page }) => {
  const errors = watch(page);
  const the = await open(page);
  await page.locator('button.artifact-review-count').click();
  const panel = page.locator('.artifact-review-panel');
  await expect(panel).toBeVisible();
  const groups = panel.locator('.artifact-review-group');
  await expect(groups.locator('.artifact-review-group-title')).toHaveText(['Merge churn', BLOCK, 'Rollout']);
  await expect(groups.nth(0).locator('li.artifact-review-entry')).toHaveCount(1);
  await expect(groups.nth(1).locator('li.artifact-review-entry')).toHaveCount(2);
  expect(await groups.nth(1).locator('li.artifact-review-entry').evaluateAll(
    (items) => items.map((item) => (item as HTMLElement).dataset.question))).toEqual(['decision-workers', 'decision-cadence']);
  // The headings' marks stay per section.
  await expect(page.locator('section.artifact-body h2', { hasText: 'Merge churn' }).locator('.artifact-review-open')).toHaveText('2 open');
  const entry = groups.nth(1).locator('li.artifact-review-entry[data-question="decision-workers"]');
  await entry.getByRole('button', { name: 'Four', exact: true }).click();
  await expect(the.form('decision-workers').getByRole('radio', { name: 'Four' })).toBeChecked();
  const saved = page.waitForResponse((response) => response.url().includes('/api/answers') && response.request().method() === 'POST');
  await panel.locator('button.artifact-review-save').click();
  expect((await saved).status()).toBe(201);
  await expect(panel.locator('.artifact-review-outcome')).toContainText('Saved at');
  const stored = await page.request.get(`/api/answers?page=${the.name}`);
  expect(stored.status()).toBe(200);
  expect(JSON.stringify((await stored.json()).questions)).toContain('four');
  await expect(the.form('decision-workers').locator('.artifact-decision-saved-line')).toContainText('Four');
  expect(errors).toEqual([]);
});

test('an answer in the form saves, and the widget keeps running in the same frame', async ({ page }) => {
  const errors = watch(page);
  const the = await open(page);
  const frame = the.figure.locator('iframe.artifact-widget');
  const inner = page.frameLocator('figure[data-widget="churn"] iframe');
  const count = async () => Number(await inner.locator('output').textContent());
  await expect.poll(count).toBeGreaterThan(1);
  const token = await inner.locator('body').evaluate(() => {
    const value = crypto.randomUUID();
    document.documentElement.dataset.continuity = value;
    return value;
  });
  const identity = await frame.evaluateHandle((node) => node);
  const form = the.form('decision-workers');
  await form.getByRole('radio', { name: 'Eight' }).check();
  await form.getByRole('button', { name: 'Save answer' }).click();
  await expect(form.locator('.artifact-decision-saved-line')).toContainText('✓ Saved');
  await expect(form.locator('.artifact-decision-saved-line')).toContainText('Eight');
  expect(await identity.evaluate((node) => node === document.querySelector('figure[data-widget="churn"] iframe.artifact-widget'))).toBe(true);
  expect(await inner.locator('html').getAttribute('data-continuity')).toBe(token);
  const now = await count();
  await expect.poll(count).toBeGreaterThan(now);
  expect(errors).toEqual([]);
});

test('pressed while the block is expanded, the link closes it first', async ({ page }) => {
  const errors = watch(page);
  const the = await open(page);
  await the.figure.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(the.figure).toHaveClass(/artifact-live--expanded/);
  await the.link.click();
  await expect(the.figure).not.toHaveClass(/artifact-live--expanded/);
  await expect(the.form('decision-workers')).toBeInViewport();
  await expect(the.form('decision-workers').locator('input').first()).toBeFocused();
  expect(errors).toEqual([]);
});

test('a swap that keeps the block running brings in its new decisions link', async ({ page }) => {
  const errors = watch(page);
  const the = await open(page);
  const identity = await the.figure.locator('iframe.artifact-widget').evaluateHandle((node) => node);
  await expect(the.link).toHaveText('2 decisions');
  publish(the.name, SOURCE.replace('| workers | How many workers next week? | Two / Four / Eight |\n', ''));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // The default picked on "Keep one merge queue?" is not saved, so the
  // section waits for its Update.
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(the.form('decision-workers')).toHaveCount(0);
  await expect(the.link).toHaveCount(1);
  await expect(the.link).toHaveText('1 decision');
  await expect(the.link).toHaveAttribute('href', '#question=decision-cadence');
  expect(await identity.evaluate((node) => node === document.querySelector('figure[data-widget="churn"] iframe.artifact-widget'))).toBe(true);
  await the.link.click();
  await expect(the.form('decision-cadence').locator('input').first()).toBeFocused();
  expect(errors).toEqual([]);
});
